import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ApprovalScope, Frame, MindconnectClient } from "../api/client";
import { collectContext, currentFileLabel } from "../context/editorContext";
import type { ServerManager } from "../server/serverManager";
import type { ChatHooks } from "./participant";
import { configuredAgent, message, openSession, TurnMetadata } from "./session";

/** What the extension tells the webview. */
type Outbound =
  | { type: "state"; agent: string; server: string; file?: string; busy: boolean }
  | { type: "reset" }
  | { type: "user"; text: string; file?: string }
  | { type: "frame"; frame: Frame }
  | { type: "done"; error?: string };

/** What the webview tells the extension. */
type Inbound =
  | { type: "ready" }
  | { type: "send"; text: string; withContext: boolean }
  | { type: "stop" }
  | { type: "new" }
  | { type: "selectAgent" }
  | { type: "approval"; callId: string; approved: boolean; scope: ApprovalScope };

/**
 * MindConnect's own chat window — in the MindConnect view container (drag it
 * to the secondary side bar to have it beside the editor) or as an editor
 * tab. It needs no Copilot: the same REST/SSE client, editor context and
 * server session as the @mindconnect participant, drawn by the extension.
 * Both surfaces show the same conversation; a webview that opens later
 * replays it.
 */
export class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "mindconnect.chatView";
  static readonly panelId = "mindconnect.chatPanel";

  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private turn: TurnMetadata | undefined;
  private abort: AbortController | undefined;
  private busy = false;
  private readonly transcript: Outbound[] = [];
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly server: ServerManager,
    private readonly client: MindconnectClient,
    private readonly hooks: ChatHooks,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => this.postState()),
      server.onDidChangeState(() => this.postState()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("mindconnect.agent")) this.postState();
      }),
    ];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.setup(view.webview);
    view.onDidDispose(() => (this.view = undefined));
  }

  async openInEditor(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(ChatView.panelId, "MindConnect Chat", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out"), vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "logo-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "logo-dark.svg"),
    };
    this.setup(this.panel.webview);
    this.panel.onDidDispose(() => (this.panel = undefined));
  }

  /** Forgets the server session; the next message starts a new one. */
  newChat(): void {
    this.stop();
    this.turn = undefined;
    this.transcript.length = 0;
    this.broadcast({ type: "reset" });
    this.postState();
  }

  dispose(): void {
    this.stop();
    this.subscriptions.forEach((s) => s.dispose());
    this.panel?.dispose();
  }

  private setup(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out"), vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webview.html = html(webview, this.extensionUri);
    webview.onDidReceiveMessage((m: Inbound) => void this.receive(m, webview));
  }

  private async receive(m: Inbound, webview: vscode.Webview): Promise<void> {
    switch (m.type) {
      case "ready":
        for (const out of this.transcript) void webview.postMessage(out);
        void webview.postMessage(this.state());
        return;
      case "send":
        return this.send(m.text, m.withContext);
      case "stop":
        return this.stop();
      case "new":
        return this.newChat();
      case "selectAgent":
        return void vscode.commands.executeCommand("mindconnect.selectAgent");
      case "approval":
        if (!this.turn) return;
        try {
          await this.client.answerApproval(this.turn.sessionId, m.callId, m.approved, m.scope);
        } catch (e) {
          void vscode.window.showErrorMessage(message(e));
        }
        return;
    }
  }

  private stop(): void {
    if (!this.abort) return;
    this.abort.abort();
    this.abort = undefined;
    if (this.turn) this.client.cancel(this.turn.sessionId).catch(() => undefined);
  }

  private async send(text: string, withContext: boolean): Promise<void> {
    if (this.busy || !text.trim()) return;
    this.busy = true;
    const context = await collectContext();
    this.server.log.info(`Chat context — ${context.summary}`);
    const file = withContext ? currentFileLabel() : undefined;
    this.broadcast({ type: "user", text, file });
    this.postState();
    let error: string | undefined;
    try {
      await this.server.ensureRunning();
      await this.hooks.ready();
      this.turn = await openSession(this.client, this.turn, context.workingDir, context.additionalDirs);
      this.hooks.workingDirChanged(this.turn.workingDir);
      const prompt = (withContext ? context.prompt : "") + text;
      this.abort = new AbortController();
      const onFrame = (frame: Frame) => {
        if (frame.type === "error") error = frame.error ?? frame.text ?? "The agent reported an error.";
        this.broadcast({ type: "frame", frame });
      };
      try {
        await this.client.chat(this.turn.sessionId, prompt, onFrame, this.abort.signal);
      } catch (e) {
        // The session is gone (deleted in the Admin UI, other data directory): start over once.
        if (!/HTTP 404/.test(message(e))) throw e;
        this.turn = await openSession(this.client, undefined, context.workingDir, context.additionalDirs);
        await this.client.chat(this.turn.sessionId, prompt, onFrame, this.abort.signal);
      }
    } catch (e) {
      if (!this.abort?.signal.aborted) error = message(e);
    } finally {
      this.abort = undefined;
      this.busy = false;
      this.broadcast({ type: "done", error });
      this.postState();
    }
  }

  private state(): Outbound {
    return { type: "state", agent: configuredAgent(), server: this.server.state.kind, file: currentFileLabel(), busy: this.busy };
  }

  private postState(): void {
    const state = this.state();
    for (const w of [this.view?.webview, this.panel?.webview]) void w?.postMessage(state);
  }

  private broadcast(out: Outbound): void {
    this.transcript.push(out);
    for (const w of [this.view?.webview, this.panel?.webview]) void w?.postMessage(out);
  }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", "webview", "chat.js"));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} https: data:`,
  ].join("; ");
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
}
