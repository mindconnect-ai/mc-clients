import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { EnvEntry, EnvStore, looksSecret } from "../server/envStore";
import * as releases from "../server/releases";
import type { ServerManager } from "../server/serverManager";

interface FormSettings {
  mode: "managed" | "external";
  url: string;
  source: "release" | "jar";
  version: string;
  jarPath: string;
  javaHome: string;
  autoStart: boolean;
}

type Inbound =
  | { type: "ready" }
  | { type: "start" | "stop" | "restart" | "showLog" | "openAdmin" }
  | { type: "browse"; field: "jarPath" | "javaHome" }
  | { type: "save"; settings: FormSettings; env: EnvEntry[] };

/**
 * The server part of the MindConnect view: status and start/stop, where the
 * server comes from (a release from Maven Central or a local jar), the Java
 * to run it with, and its environment — API keys go to the secret storage.
 * Everything here is also plain settings; this is the form over them.
 */
export class ServerView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "mindconnect.server";

  private view: vscode.WebviewView | undefined;
  private versions: string[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly server: ServerManager, private readonly env: EnvStore, private readonly serverDir: string) {
    this.subscriptions.push(
      server.onDidChangeState(() => void this.post()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("mindconnect.server")) void this.post();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = page(view.webview);
    view.webview.onDidReceiveMessage((m: Inbound) => void this.receive(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
  }

  private async receive(m: Inbound): Promise<void> {
    switch (m.type) {
      case "ready":
        await this.post();
        void this.loadVersions();
        return;
      case "start":
        return void vscode.commands.executeCommand("mindconnect.server.start");
      case "stop":
        return void this.server.stop();
      case "restart":
        return void vscode.commands.executeCommand("mindconnect.server.restart");
      case "showLog":
        return this.server.showLog();
      case "openAdmin":
        return void vscode.commands.executeCommand("mindconnect.adminUi.openInEditor");
      case "browse": {
        const jar = m.field === "jarPath";
        const picked = await vscode.window.showOpenDialog({
          title: jar ? "Server jar (mc-agent-admin-ui-app-*-exec.jar)" : "Java 21+ home directory",
          canSelectFiles: jar,
          canSelectFolders: !jar,
          filters: jar ? { "Executable jar": ["jar"] } : undefined,
        });
        if (picked?.[0]) void this.view?.webview.postMessage({ type: "picked", field: m.field, path: picked[0].fsPath });
        return;
      }
      case "save":
        await this.save(m.settings, m.env);
        return;
    }
  }

  private async save(s: FormSettings, env: EnvEntry[]): Promise<void> {
    const config = vscode.workspace.getConfiguration("mindconnect.server");
    const global = vscode.ConfigurationTarget.Global;
    await config.update("mode", s.mode, global);
    await config.update("url", s.url.trim() || "http://localhost:9090", global);
    await config.update("version", s.source === "release" ? s.version || "latest" : config.get("version"), global);
    await config.update("jarPath", s.source === "jar" ? s.jarPath.trim() : "", global);
    await config.update("javaHome", s.javaHome.trim(), global);
    await config.update("autoStart", s.autoStart, global);
    await this.env.save(env.map((e) => ({ ...e, secret: e.secret || looksSecret(e.name) })));
    const running = this.server.state.kind === "running";
    void this.view?.webview.postMessage({ type: "saved", restartHint: running });
    await this.post();
  }

  private async loadVersions(): Promise<void> {
    try {
      this.versions = await releases.listVersions();
    } catch {
      this.versions = await releases.installedVersions(this.serverDir);
    }
    await this.post();
  }

  private async post(): Promise<void> {
    if (!this.view) return;
    const config = vscode.workspace.getConfiguration("mindconnect.server");
    const jarPath = config.get<string>("jarPath") ?? "";
    const settings: FormSettings = {
      mode: config.get<"managed" | "external">("mode") ?? "managed",
      url: config.get<string>("url") ?? "",
      source: jarPath ? "jar" : "release",
      version: config.get<string>("version") ?? "latest",
      jarPath,
      javaHome: config.get<string>("javaHome") ?? "",
      autoStart: config.get<boolean>("autoStart") ?? true,
    };
    const s = this.server.state;
    const status =
      s.kind === "running" ? `Running at ${s.url}${s.managed ? ` · ${s.version ?? "local jar"}` : " · external"}`
      : s.kind === "starting" ? `Starting — ${s.detail} …`
      : s.kind === "failed" ? `Failed — ${s.message}`
      : "Stopped";
    await this.view.webview.postMessage({
      type: "state",
      state: s.kind,
      status,
      settings,
      env: await this.env.entries(),
      versions: this.versions,
    });
  }
}

function page(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString("base64");
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 4px 8px 16px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 16px 0 6px; font-weight: 600; }
  .status { display: flex; align-items: center; gap: 6px; margin: 4px 0 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-disabledForeground); flex: none; }
  .dot.running { background: var(--vscode-testing-iconPassed); }
  .dot.starting { background: var(--vscode-editorWarning-foreground); }
  .dot.failed { background: var(--vscode-errorForeground); }
  .row { display: flex; gap: 4px; margin: 4px 0; align-items: center; flex-wrap: wrap; }
  label { display: block; margin: 8px 0 2px; color: var(--vscode-descriptionForeground); }
  input[type=text], input[type=password], select {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); padding: 3px 5px; min-width: 0; flex: 1; font: inherit;
  }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 10px; cursor: pointer; font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.icon { background: transparent; color: var(--vscode-icon-foreground); padding: 2px 6px; }
  button:disabled { opacity: .5; cursor: default; }
  .radio { display: flex; gap: 12px; margin: 4px 0; }
  .radio label { display: flex; gap: 4px; align-items: center; margin: 0; color: var(--vscode-foreground); }
  .hidden { display: none; }
  .env .row input.name { flex: 0 1 40%; font-family: var(--vscode-editor-font-family); }
  .env .row input.value { font-family: var(--vscode-editor-font-family); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 6px 0; }
  .saved { color: var(--vscode-testing-iconPassed); }
</style>
</head><body>
  <div class="status"><span class="dot" id="dot"></span><span id="status">…</span></div>
  <div class="row">
    <button id="start">Start</button>
    <button id="restart" class="secondary">Restart</button>
    <button id="stop" class="secondary">Stop</button>
    <button id="log" class="secondary">Log</button>
    <button id="admin" class="secondary">Admin UI</button>
  </div>

  <h3>Server</h3>
  <div class="radio">
    <label><input type="radio" name="mode" value="managed"> Run locally</label>
    <label><input type="radio" name="mode" value="external"> Connect to URL</label>
  </div>
  <div id="external">
    <label for="url">Server URL</label>
    <div class="row"><input type="text" id="url" placeholder="http://localhost:9090"></div>
  </div>
  <div id="managed">
    <label>Server jar</label>
    <div class="radio">
      <label><input type="radio" name="source" value="release"> Release</label>
      <label><input type="radio" name="source" value="jar"> Local jar</label>
    </div>
    <div class="row" id="release"><select id="version"></select></div>
    <div class="row hidden" id="jar">
      <input type="text" id="jarPath" placeholder="…/mc-agent-admin-ui-app-*-exec.jar">
      <button class="secondary" id="browseJar">…</button>
    </div>
    <label for="javaHome">Java 21+ home</label>
    <div class="row">
      <input type="text" id="javaHome" placeholder="JAVA_HOME or java on PATH">
      <button class="secondary" id="browseJava">…</button>
    </div>
    <div class="row"><label style="display:flex;gap:4px;align-items:center;margin:4px 0;color:var(--vscode-foreground)"><input type="checkbox" id="autoStart"> Start when the chat needs it</label></div>

    <h3>Environment</h3>
    <div class="hint">Names with KEY, SECRET, TOKEN or PASSWORD are stored in the OS keychain, not in settings.json.</div>
    <div class="env" id="env"></div>
    <div class="row"><button class="secondary" id="addEnv">Add variable</button></div>
  </div>

  <div class="row" style="margin-top:14px">
    <button id="save">Save</button>
    <span id="saved" class="hint"></span>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const secretName = (n) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(n);
  let dirty = false;

  for (const [id, type] of [["start","start"],["restart","restart"],["stop","stop"],["log","showLog"],["admin","openAdmin"]])
    $(id).addEventListener("click", () => vscode.postMessage({ type }));
  $("browseJar").addEventListener("click", () => vscode.postMessage({ type: "browse", field: "jarPath" }));
  $("browseJava").addEventListener("click", () => vscode.postMessage({ type: "browse", field: "javaHome" }));
  $("addEnv").addEventListener("click", () => { addEnvRow({ name: "", value: "", secret: false }); dirty = true; });
  document.addEventListener("input", () => { dirty = true; $("saved").textContent = ""; });
  document.addEventListener("change", layout);
  $("save").addEventListener("click", save);

  function radio(name) { return document.querySelector('input[name="' + name + '"]:checked')?.value; }
  function setRadio(name, value) { for (const r of document.getElementsByName(name)) r.checked = r.value === value; }

  function layout() {
    const managed = radio("mode") === "managed";
    $("managed").classList.toggle("hidden", !managed);
    $("external").classList.toggle("hidden", managed);
    const jar = radio("source") === "jar";
    $("jar").classList.toggle("hidden", !jar);
    $("release").classList.toggle("hidden", jar);
  }

  function addEnvRow(e) {
    const row = document.createElement("div");
    row.className = "row";
    const name = Object.assign(document.createElement("input"), { type: "text", className: "name", value: e.name, placeholder: "NAME" });
    const value = Object.assign(document.createElement("input"), {
      type: e.secret ? "password" : "text", className: "value", value: e.value,
      placeholder: e.secret ? "•••••• (stored — type to replace)" : "value",
    });
    value.dataset.secret = e.secret ? "1" : "";
    name.addEventListener("input", () => {
      const secret = value.dataset.secret === "1" || secretName(name.value);
      value.type = secret ? "password" : "text";
    });
    const remove = Object.assign(document.createElement("button"), { className: "icon", title: "Remove", textContent: "✕" });
    remove.addEventListener("click", () => { row.remove(); dirty = true; });
    row.append(name, value, remove);
    $("env").append(row);
  }

  function save() {
    const env = [...$("env").children].map((row) => {
      const [name, value] = row.querySelectorAll("input");
      return { name: name.value.trim(), value: value.value, secret: value.dataset.secret === "1" || secretName(name.value) };
    }).filter((e) => e.name);
    vscode.postMessage({ type: "save", env, settings: {
      mode: radio("mode"), url: $("url").value, source: radio("source"), version: $("version").value,
      jarPath: $("jarPath").value, javaHome: $("javaHome").value, autoStart: $("autoStart").checked,
    }});
  }

  window.addEventListener("message", ({ data }) => {
    if (data.type === "picked") { $(data.field).value = data.path; dirty = true; return; }
    if (data.type === "saved") {
      dirty = false;
      $("saved").textContent = data.restartHint ? "Saved — restart the server to apply." : "Saved.";
      $("saved").className = "hint saved";
      return;
    }
    if (data.type !== "state") return;
    $("dot").className = "dot " + data.state;
    $("status").textContent = data.status;
    const running = data.state === "running", starting = data.state === "starting";
    $("start").disabled = running || starting;
    $("stop").disabled = !running && !starting;
    $("restart").disabled = !running || data.settings.mode !== "managed";
    $("admin").disabled = !running;
    if (dirty) return; // do not overwrite what the user is typing
    const s = data.settings;
    setRadio("mode", s.mode);
    setRadio("source", s.source);
    $("url").value = s.url;
    $("jarPath").value = s.jarPath;
    $("javaHome").value = s.javaHome;
    $("autoStart").checked = s.autoStart;
    const versions = ["latest", ...data.versions.filter((v) => v !== "latest")];
    if (!versions.includes(s.version)) versions.push(s.version);
    $("version").replaceChildren(...versions.map((v) =>
      Object.assign(document.createElement("option"), { value: v, textContent: v === "latest" ? "latest release" : v, selected: v === s.version })));
    $("env").replaceChildren();
    data.env.forEach(addEnvRow);
    layout();
  });
  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
