import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as vscode from "vscode";
import { z } from "zod";
import { Decision, ProposalManager } from "./proposals";

/**
 * The server's MCP gateway gives up on a call after 60 s; answer before
 * that, with “still under review”, and apply the change if it comes later.
 */
const DECISION_WAIT_MS = 50_000;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * The back channel: an MCP server inside the extension, bound to 127.0.0.1
 * and guarded by a bearer token, that the MindConnect server reaches through
 * its MCP gateway. Its tools act in this VS Code window — change proposals as
 * diffs, opening files, the language services' diagnostics.
 *
 * Stateless streamable HTTP: a fresh McpServer per request, no MCP session to
 * lose when either side restarts.
 */
export class VsCodeToolServer implements vscode.Disposable {
  private server: http.Server | undefined;
  readonly token = randomBytes(24).toString("base64url");
  private port = 0;

  /** The folder a relative path is resolved in — the chat's working directory. */
  workingDir: (() => string | undefined) | undefined;

  constructor(private readonly proposals: ProposalManager, private readonly log: vscode.LogOutputChannel) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<string> {
    if (this.server) return this.url;
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    this.log.info(`VS Code tool server listening at ${this.url}`);
    return this.url;
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.url?.startsWith("/mcp")) return void res.writeHead(404).end();
    if (!this.authorized(req.headers.authorization)) return void res.writeHead(401).end();
    if (req.method !== "POST") {
      // Stateless: no server-initiated stream (GET) and no session to end (DELETE).
      return void res.writeHead(405, { allow: "POST" }).end();
    }
    const mcp = this.mcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      this.log.error(`MCP request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private authorized(header: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.token}`);
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private mcpServer(): McpServer {
    const mcp = new McpServer({ name: "vscode", version: "0.1.0" });

    mcp.registerTool("edit_file", {
      description: "Proposes replacing one exact passage of a text file in the user's VS Code. The user sees "
        + "the change as a diff and accepts or rejects it — nothing is written before they accept. Works on "
        + "the editor's buffer, unsaved changes included. old_string must match exactly and, unless "
        + "replace_all is set, occur once; read the file first.",
      inputSchema: {
        path: z.string().describe("File path, relative to the working directory or absolute"),
        old_string: z.string().describe("The exact text to replace"),
        new_string: z.string().describe("The replacement"),
        replace_all: z.boolean().optional().describe("Replace every occurrence instead of exactly one"),
      },
    }, async ({ path: p, old_string, new_string, replace_all }) => this.safely(async () => {
      const target = this.resolve(p);
      const base = await currentText(target);
      if (base === null) return error(`${p} does not exist — use write_file for a new file.`);
      const count = base.split(old_string).length - 1;
      if (!old_string || count === 0) return error(`old_string not found in ${p}. Read the file again; it may have changed.`);
      if (count > 1 && !replace_all) return error(`old_string occurs ${count} times in ${p} — add context to make it unique, or set replace_all.`);
      const proposed = replace_all ? base.split(old_string).join(new_string) : base.replace(old_string, () => new_string);
      return this.review(target, base, proposed);
    }));

    mcp.registerTool("write_file", {
      description: "Proposes the complete content of a file in the user's VS Code — for a new file or a "
        + "rewrite. The user sees it as a diff and accepts or rejects it; nothing is written before they "
        + "accept. For a change to part of an existing file, prefer edit_file.",
      inputSchema: {
        path: z.string().describe("File path, relative to the working directory or absolute"),
        content: z.string().describe("The whole new content"),
      },
    }, async ({ path: p, content }) => this.safely(async () => {
      const target = this.resolve(p);
      return this.review(target, await currentText(target), content);
    }));

    mcp.registerTool("open_file", {
      description: "Opens a file in the user's editor and selects lines — to show the user a place in the code.",
      inputSchema: {
        path: z.string().describe("File path, relative to the working directory or absolute"),
        line: z.number().int().positive().optional().describe("First line to select, 1-based"),
        end_line: z.number().int().positive().optional().describe("Last line to select, 1-based"),
      },
    }, async ({ path: p, line, end_line }) => this.safely(async () => {
      const target = this.resolve(p);
      const doc = await vscode.workspace.openTextDocument(target);
      const from = Math.min(Math.max((line ?? 1) - 1, 0), doc.lineCount - 1);
      const to = Math.min(Math.max((end_line ?? line ?? 1) - 1, from), doc.lineCount - 1);
      const range = new vscode.Range(from, 0, to, doc.lineAt(to).text.length);
      await vscode.window.showTextDocument(doc, { selection: range, preview: false });
      return text(`Opened ${vscode.workspace.asRelativePath(target)} at line ${from + 1}.`);
    }));

    mcp.registerTool("get_diagnostics", {
      description: "The errors and warnings VS Code's language services report — compiler, linter, type "
        + "checker — for one file, or for every file with problems when path is omitted.",
      inputSchema: {
        path: z.string().optional().describe("File path; omit for the whole workspace"),
      },
    }, async ({ path: p }) => this.safely(async () => {
      const entries: [vscode.Uri, readonly vscode.Diagnostic[]][] = p
        ? [[this.resolve(p), vscode.languages.getDiagnostics(this.resolve(p))]]
        : vscode.languages.getDiagnostics();
      const lines: string[] = [];
      for (const [uri, diagnostics] of entries) {
        for (const d of diagnostics.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)) {
          const level = d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
          lines.push(`${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1}: `
            + `${level}: ${d.message}${d.source ? ` (${d.source})` : ""}`);
          if (lines.length >= 200) break;
        }
      }
      return text(lines.length ? lines.join("\n") : "No errors or warnings.");
    }));

    return mcp;
  }

  /** Shows the proposal and waits a while for the verdict. */
  private async review(target: vscode.Uri, base: string | null, proposed: string): Promise<ToolResult> {
    const name = vscode.workspace.asRelativePath(target);
    if (base !== null && base === proposed) return text(`${name} already has this content — nothing to change.`);
    const decision = this.proposals.propose(target, base, proposed);
    const timeout = new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), DECISION_WAIT_MS));
    const outcome: Decision | "pending" = await Promise.race([decision, timeout]);
    if (outcome === "pending") {
      return text(`The change to ${name} is shown to the user as a diff and still awaits review. Do not propose `
        + "it again. Carry on or finish your answer; if the user accepts it later, it is applied then.");
    }
    switch (outcome.kind) {
      case "accepted":
        return text(`The user accepted the change; ${name} is updated${outcome.saved ? " and saved" : " (not saved yet)"}.`);
      case "rejected":
        return text(`The user rejected the change to ${name}; the file is unchanged. Do not apply it another way — `
          + "ask what they want instead.");
      case "conflict":
        return error(`The change to ${name} was not applied: ${outcome.reason}. Read the file again before proposing anew.`);
    }
  }

  /**
   * A path the agent named, as a URI in this window's workspace — relative
   * ones against the chat's working directory. Anything outside the open
   * folders is refused: the agent works on this project, not the whole disk.
   */
  private resolve(p: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const base = this.workingDir?.() ?? folders[0]?.uri.fsPath;
    const absolute = path.isAbsolute(p) ? path.normalize(p) : base ? path.resolve(base, p) : undefined;
    if (!absolute) throw new Error("No workspace folder is open in VS Code.");
    const inside = folders.some((f) => {
      const rel = path.relative(f.uri.fsPath, absolute);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!inside) throw new Error(`${p} lies outside the folders open in VS Code.`);
    return vscode.Uri.file(absolute);
  }

  private async safely(run: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await run();
    } catch (e) {
      return error(e instanceof Error ? e.message : String(e));
    }
  }
}

/** The text as the user sees it: an open buffer (unsaved changes included), else the disk; null when the file does not exist. */
async function currentText(uri: vscode.Uri): Promise<string | null> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return await fs.readFile(uri.fsPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function error(t: string): ToolResult {
  // The tool-call worker reads a failure by this prefix (see McpToolAdapter).
  return { content: [{ type: "text", text: `Error: ${t}` }], isError: true };
}
