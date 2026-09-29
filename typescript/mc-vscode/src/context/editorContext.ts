import * as path from "node:path";
import * as vscode from "vscode";

/** What the agent learns about where the user is — sent ahead of each message. */
export interface EditorContext {
  /** The workspace folder of the active file (else the first one) — the session's working directory. */
  workingDir?: string;
  /** The other workspace folders, reachable by absolute path. */
  additionalDirs: string[];
  /** The context block that goes in front of the user's message. */
  prompt: string;
  /** Files the block draws on, shown as references under the answer. */
  used: vscode.Uri[];
}

const MAX_SELECTION_CHARS = 20_000;
const MAX_REFERENCE_CHARS = 40_000;
const CURSOR_WINDOW_LINES = 20;
const MAX_DIAGNOSTICS = 20;

/**
 * Collects the editor state for one chat turn: workspace folder, active file
 * with selection (or the lines around the cursor), its errors and warnings,
 * the Git branch, the other visible files, and whatever the user attached
 * with #file / #selection.
 *
 * Unsaved changes travel as text — the agent's file tools read the disk, which
 * does not have them yet.
 */
export async function collectContext(request: vscode.ChatRequest): Promise<EditorContext> {
  const editor = currentEditor();
  const folders = vscode.workspace.workspaceFolders ?? [];
  const active = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
  const root = active ?? folders[0];

  const lines: string[] = [];
  const used: vscode.Uri[] = [];
  if (root) {
    lines.push(`Workspace folder: ${root.uri.fsPath}`);
    const branch = gitBranch(root.uri);
    if (branch) lines.push(`Git branch: ${branch}`);
  }
  if (folders.length > 1) {
    lines.push(`Other workspace folders: ${folders.filter((f) => f !== root).map((f) => f.uri.fsPath).join(", ")}`);
  }

  if (editor && editor.document.uri.scheme !== "output") {
    const doc = editor.document;
    used.push(doc.uri);
    lines.push("", `Active file: ${display(doc.uri, root)} (${doc.languageId}, ${doc.lineCount} lines${doc.isDirty ? ", unsaved changes" : ""})`);
    const sel = editor.selection;
    if (!sel.isEmpty) {
      lines.push(`Selection: lines ${sel.start.line + 1}–${sel.end.line + 1}`);
      lines.push(fence(doc.languageId, truncate(doc.getText(sel), MAX_SELECTION_CHARS)));
    } else {
      const cursor = sel.active.line;
      const from = Math.max(0, cursor - CURSOR_WINDOW_LINES);
      const to = Math.min(doc.lineCount - 1, cursor + CURSOR_WINDOW_LINES);
      lines.push(`Cursor: line ${cursor + 1}. Lines ${from + 1}–${to + 1}:`);
      lines.push(fence(doc.languageId, numbered(doc, from, to)));
    }
    const problems = vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
      .slice(0, MAX_DIAGNOSTICS);
    if (problems.length) {
      lines.push("Problems in this file:");
      for (const d of problems) {
        const level = d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
        lines.push(`- line ${d.range.start.line + 1}: ${level}: ${d.message}${d.source ? ` (${d.source})` : ""}`);
      }
    }
  }

  const others = vscode.window.visibleTextEditors
    .map((e) => e.document.uri)
    .filter((u) => u.scheme === "file" && u.toString() !== editor?.document.uri.toString());
  if (others.length) lines.push("", `Also open: ${others.map((u) => display(u, root)).join(", ")}`);

  for (const ref of request.references) {
    const attached = await describeReference(ref, root);
    if (attached) {
      lines.push("", attached.text);
      used.push(attached.uri);
    }
  }

  const prompt = lines.length
    ? `<editor-context>\nThe user is working in VS Code. This is where they are right now:\n${lines.join("\n")}\n</editor-context>\n\n`
    : "";
  return {
    workingDir: root?.uri.scheme === "file" ? root.uri.fsPath : undefined,
    additionalDirs: folders.filter((f) => f !== root && f.uri.scheme === "file").map((f) => f.uri.fsPath),
    prompt,
    used,
  };
}

let lastActive: vscode.TextEditor | undefined;

/**
 * Remembers the last text editor that had focus. activeTextEditor is empty
 * while the focus is elsewhere and no editor has had it yet — right after a
 * window reload, with the file plainly on screen, the first chat turn would
 * otherwise go out without it.
 */
export function trackActiveEditor(): vscode.Disposable {
  lastActive = vscode.window.activeTextEditor ?? lastActive;
  return vscode.window.onDidChangeActiveTextEditor((e) => {
    if (e && e.document.uri.scheme !== "output") lastActive = e;
  });
}

/**
 * The file the user is looking at: the active editor; else the last one that
 * was, while it is still on screen; else the file in the active tab of any
 * editor group (the chat may itself be an editor tab); else the first visible
 * file editor.
 */
function currentEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active) return active;
  const visible = vscode.window.visibleTextEditors.filter((e) => e.document.uri.scheme === "file");
  const shown = (uri: vscode.Uri) => visible.find((e) => e.document.uri.toString() === uri.toString());
  if (lastActive && shown(lastActive.document.uri)) return shown(lastActive.document.uri);
  const groups = [vscode.window.tabGroups.activeTabGroup, ...vscode.window.tabGroups.all];
  for (const group of groups) {
    const input = group.activeTab?.input;
    if (input instanceof vscode.TabInputText) {
      const editor = shown(input.uri);
      if (editor) return editor;
    }
  }
  return visible[0];
}

/** A #file or #selection attachment as text. */
async function describeReference(
  ref: vscode.ChatPromptReference,
  root: vscode.WorkspaceFolder | undefined,
): Promise<{ text: string; uri: vscode.Uri } | undefined> {
  const value = ref.value;
  if (value instanceof vscode.Uri) {
    const doc = await vscode.workspace.openTextDocument(value).then(undefined, () => undefined);
    if (!doc) return { text: `Attached: ${display(value, root)} (not a text file)`, uri: value };
    return {
      text: `Attached file ${display(value, root)}:\n${fence(doc.languageId, truncate(doc.getText(), MAX_REFERENCE_CHARS))}`,
      uri: value,
    };
  }
  if (value instanceof vscode.Location) {
    const doc = await vscode.workspace.openTextDocument(value.uri).then(undefined, () => undefined);
    if (!doc) return undefined;
    const { start, end } = value.range;
    return {
      text: `Attached ${display(value.uri, root)}, lines ${start.line + 1}–${end.line + 1}:\n`
        + fence(doc.languageId, truncate(doc.getText(value.range), MAX_REFERENCE_CHARS)),
      uri: value.uri,
    };
  }
  return undefined;
}

/** The checked-out branch from the built-in Git extension, if it is active and knows the folder. */
function gitBranch(folder: vscode.Uri): string | undefined {
  const git = vscode.extensions.getExtension("vscode.git");
  if (!git?.isActive) return undefined;
  try {
    const api = git.exports.getAPI(1);
    const repo = api.getRepository(folder);
    return repo?.state?.HEAD?.name;
  } catch {
    return undefined;
  }
}

function display(uri: vscode.Uri, root: vscode.WorkspaceFolder | undefined): string {
  if (root && uri.fsPath.startsWith(root.uri.fsPath + path.sep)) return path.relative(root.uri.fsPath, uri.fsPath);
  return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

function numbered(doc: vscode.TextDocument, from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${String(i + 1).padStart(5)}  ${doc.lineAt(i).text}`);
  return out.join("\n");
}

function fence(language: string, text: string): string {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}${language}\n${text}\n${ticks}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters cut)`;
}
