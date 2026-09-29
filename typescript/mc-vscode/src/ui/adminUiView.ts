import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ServerManager } from "../server/serverManager";
import { AdminUiProxy } from "./adminUiProxy";

/**
 * The Admin UI inside VS Code, without an address bar, as an editor tab —
 * the room its forms and tables need. Framed through {@link AdminUiProxy}.
 */
export class AdminUi implements vscode.Disposable {
  static readonly panelId = "mindconnect.adminUiPanel";

  private readonly proxy: AdminUiProxy;
  private panel: vscode.WebviewPanel | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly server: ServerManager, private readonly extensionUri: vscode.Uri) {
    this.proxy = new AdminUiProxy(server.log);
    this.subscription = server.onDidChangeState(() => void this.refresh());
  }

  async openInEditor(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(AdminUi.panelId, "MindConnect Admin", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "logo-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "logo-dark.svg"),
    };
    this.configure(this.panel.webview);
    this.panel.onDidDispose(() => (this.panel = undefined));
    await this.refresh();
  }

  /** Reloads the page — after a server restart, or when it got stuck. */
  async reload(): Promise<void> {
    await this.refresh(true);
  }

  dispose(): void {
    this.subscription.dispose();
    this.panel?.dispose();
    this.proxy.dispose();
  }

  private configure(webview: vscode.Webview): void {
    webview.options = { enableScripts: true };
    webview.onDidReceiveMessage((m: { type: string }) => {
      if (m.type === "start") void vscode.commands.executeCommand("mindconnect.server.start");
    });
  }

  private async refresh(force = false): Promise<void> {
    const url = this.server.url;
    this.proxy.setTarget(url);
    // mc-host=vscode tells the Admin UI it is embedded — it switches to the theme
    // that takes VS Code's colours (see the host-theme message below).
    const src = url ? `${await this.proxy.start()}/?mc-host=vscode&v=${force ? Date.now() : 0}` : undefined;
    if (this.panel) this.panel.webview.html = html(this.panel.webview, src, this.server.state.kind);
  }
}

function html(webview: vscode.Webview, src: string | undefined, state: string): string {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'none'",
    "frame-src http://127.0.0.1:*",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const body = src
    ? `<iframe src="${src}" allow="clipboard-read; clipboard-write"></iframe>`
    : `<div class="empty">
         <p>${state === "starting" ? "The MindConnect server is starting …" : "The MindConnect server is not running."}</p>
         ${state === "starting" ? "" : `<button id="start">Start Server</button>`}
       </div>`;
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
  iframe { border: 0; width: 100%; height: 100vh; display: block; background: var(--vscode-editor-background); }
  .empty { padding: 12px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head><body>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById("start")?.addEventListener("click", () => vscode.postMessage({ type: "start" }));

  // Host theme: VS Code's colours as CSS variables, handed to the Admin UI, which
  // maps them onto its own tokens. Sent when the frame loads, when it says it is
  // ready, and whenever VS Code switches theme (class on <body>, style on <html>).
  const frame = document.querySelector("iframe");
  if (frame) {
    const target = new URL(frame.src).origin;
    const kind = () => {
      const c = document.body.classList;
      return c.contains("vscode-high-contrast-light") ? "high-contrast-light"
        : c.contains("vscode-high-contrast") ? "high-contrast"
        : c.contains("vscode-light") ? "light" : "dark";
    };
    const vars = () => {
      const out = {};
      const inline = document.documentElement.style;
      for (let i = 0; i < inline.length; i++) {
        const name = inline[i];
        if (name.startsWith("--vscode-")) out[name] = inline.getPropertyValue(name).trim();
      }
      return out;
    };
    const send = () => frame.contentWindow?.postMessage({ type: "mc-host-theme", version: 1, host: "vscode", kind: kind(), vars: vars() }, target);
    frame.addEventListener("load", send);
    window.addEventListener("message", (e) => { if (e.source === frame.contentWindow && e.data?.type === "mc-host-ready") send(); });
    new MutationObserver(send).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    new MutationObserver(send).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  }
</script>
</body></html>`;
}
