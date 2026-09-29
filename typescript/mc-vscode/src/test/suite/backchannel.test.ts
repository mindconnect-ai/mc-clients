import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as vscode from "vscode";
import { PROPOSAL_SCHEME, ProposalManager } from "../../backchannel/proposals";
import { VsCodeToolServer } from "../../backchannel/toolServer";

/**
 * The back channel against the real VS Code API: an MCP client plays the
 * MindConnect gateway, the test plays the user clicking Accept / Reject.
 */
suite("Back channel", function () {
  this.timeout(30_000);

  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const file = path.join(root, "hello.txt");
  let proposals: ProposalManager;
  let tools: VsCodeToolServer;
  let client: Client;

  suiteSetup(async () => {
    proposals = new ProposalManager();
    tools = new VsCodeToolServer(proposals, vscode.window.createOutputChannel("test", { log: true }));
    const url = await tools.start();
    client = new Client({ name: "test-gateway", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${tools.token}` } },
    }));
  });

  suiteTeardown(async () => {
    await fs.writeFile(file, "hello\n");
    await client.close();
    tools.dispose();
    proposals.dispose();
  });

  setup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await fs.writeFile(file, "hello\n");
  });

  test("lists the four tools", async () => {
    const { tools: listed } = await client.listTools();
    assert.deepStrictEqual(listed.map((t) => t.name).sort(), ["edit_file", "get_diagnostics", "open_file", "write_file"]);
  });

  test("refuses a call without the token", async () => {
    const res = await fetch(tools.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.strictEqual(res.status, 401);
  });

  test("accepted edit lands in the file and is saved", async () => {
    const call = callText("edit_file", { path: "hello.txt", old_string: "hello", new_string: "hello world" });
    await decide("accept");
    assert.match(await call, /accepted.*saved/);
    assert.strictEqual(await fs.readFile(file, "utf8"), "hello world\n");
    assert.strictEqual(diffTabs().length, 0, "the diff is closed after the decision");
  });

  test("rejected edit leaves the file alone", async () => {
    const call = callText("edit_file", { path: "hello.txt", old_string: "hello", new_string: "bye" });
    await decide("reject");
    assert.match(await call, /rejected/);
    assert.strictEqual(await fs.readFile(file, "utf8"), "hello\n");
  });

  test("edits the buffer, unsaved changes included", async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((b) => b.insert(new vscode.Position(1, 0), "unsaved line\n"));
    assert.ok(doc.isDirty);

    const call = callText("edit_file", { path: "hello.txt", old_string: "unsaved line", new_string: "reviewed line" });
    await decide("accept");
    assert.match(await call, /accepted/);
    assert.strictEqual(await fs.readFile(file, "utf8"), "hello\nreviewed line\n");
  });

  test("write_file proposes a new file", async () => {
    const created = path.join(root, "new", "created.txt");
    await fs.rm(path.join(root, "new"), { recursive: true, force: true });
    const call = callText("write_file", { path: "new/created.txt", content: "fresh\n" });
    await decide("accept");
    assert.match(await call, /accepted/);
    assert.strictEqual(await fs.readFile(created, "utf8"), "fresh\n");
    await fs.rm(path.join(root, "new"), { recursive: true, force: true });
  });

  test("an ambiguous old_string is an error, not a proposal", async () => {
    await fs.writeFile(file, "a\na\n");
    const result = await callText("edit_file", { path: "hello.txt", old_string: "a", new_string: "b" });
    assert.match(result, /^Error: .*occurs 2 times/);
    assert.strictEqual(diffTabs().length, 0);
  });

  test("a path outside the workspace is refused", async () => {
    const result = await callText("write_file", { path: "/etc/mindconnect-test", content: "x" });
    assert.match(result, /^Error: .*outside the folders open in VS Code/);
  });

  test("open_file selects the lines", async () => {
    await fs.writeFile(file, "one\ntwo\nthree\n");
    await callText("open_file", { path: "hello.txt", line: 2, end_line: 3 });
    const editor = vscode.window.activeTextEditor!;
    assert.strictEqual(editor.document.uri.fsPath, file);
    assert.strictEqual(editor.selection.start.line, 1);
    assert.strictEqual(editor.selection.end.line, 2);
  });

  async function callText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  }

  /** Waits for the proposal's diff, then clicks like the user would. */
  async function decide(choice: "accept" | "reject"): Promise<void> {
    for (let i = 0; i < 100 && diffTabs().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    const [tab] = diffTabs();
    assert.ok(tab, "a proposal diff opened");
    await vscode.commands.executeCommand(`mindconnect.proposal.${choice}`, (tab.input as vscode.TabInputTextDiff).modified);
  }

  function diffTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === PROPOSAL_SCHEME);
  }
});
