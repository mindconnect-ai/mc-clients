import { ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { MindconnectClient } from "../api/client";
import type { EnvStore } from "./envStore";
import * as releases from "./releases";

export type ServerState =
  | { kind: "stopped" }
  | { kind: "starting"; detail: string }
  | { kind: "running"; url: string; managed: false }
  | { kind: "running"; url: string; managed: true; version?: string; dataDir: string; namespace: string }
  | { kind: "failed"; message: string };

const STARTUP_TIMEOUT_MS = 180_000;
const STOP_GRACE_MS = 15_000;
const ENCRYPTION_KEY_SECRET = "mindconnect.server.encryptionKey";

/**
 * Owns the server the chat talks to. In managed mode it downloads the release
 * jar (after asking), runs it with Java 21 on a free port bound to 127.0.0.1,
 * streams its output into an output channel and stops it with the window. In
 * external mode it only checks that the configured URL answers.
 */
export class ServerManager implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ServerState>();
  readonly onDidChangeState = this.changed.event;

  readonly log = vscode.window.createOutputChannel("MindConnect Server", { log: true });
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private current: ServerState = { kind: "stopped" };
  private process: ChildProcess | undefined;
  private starting: Promise<string> | undefined;

  constructor(
    private readonly storage: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly envStore: EnvStore,
  ) {
    this.status.command = "mindconnect.showMenu";
    this.status.name = "MindConnect Server";
    this.render();
    this.status.show();
  }

  get state(): ServerState {
    return this.current;
  }

  /** Base URL of a server that answers, or undefined when none is up. */
  get url(): string | undefined {
    return this.current.kind === "running" ? this.current.url : undefined;
  }

  /** The server's base URL, starting (managed) or probing (external) it first when needed. */
  ensureRunning(): Promise<string> {
    if (this.current.kind === "running") return Promise.resolve(this.current.url);
    if (this.starting) return this.starting;
    const config = vscode.workspace.getConfiguration("mindconnect.server");
    if (config.get<string>("mode") === "managed" && !config.get<boolean>("autoStart")) {
      return Promise.reject(new Error("The MindConnect server is not running — run “MindConnect: Start Local Server”."));
    }
    return this.start();
  }

  start(): Promise<string> {
    if (this.current.kind === "running") return Promise.resolve(this.current.url);
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => (this.starting = undefined));
    return this.starting;
  }

  /** Where releases are downloaded to and the managed server keeps its data. */
  get serverDir(): string {
    return vscode.Uri.joinPath(this.storage, "server").fsPath;
  }

  /** Stop, then start with the current settings — how a changed jar or environment takes effect. */
  async restart(): Promise<string> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child || child.exitCode !== null) {
      this.set({ kind: "stopped" });
      return;
    }
    this.log.info("Stopping the server …");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  showLog(): void {
    this.log.show(true);
  }

  dispose(): void {
    // The window is closing: no grace period to wait for, a TERM lets Spring shut down cleanly.
    this.process?.kill("SIGTERM");
    this.status.dispose();
    this.log.dispose();
    this.changed.dispose();
  }

  private async doStart(): Promise<string> {
    const config = vscode.workspace.getConfiguration("mindconnect.server");
    try {
      if (config.get<string>("mode") === "external") {
        const url = config.get<string>("url") ?? "http://localhost:9090";
        this.set({ kind: "starting", detail: `connecting to ${url}` });
        if (!(await new MindconnectClient(() => url).ping())) {
          throw new Error(`No MindConnect server answers at ${url}.`);
        }
        this.set({ kind: "running", url, managed: false });
        return url;
      }
      return await this.startManaged(config);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error(message);
      this.set({ kind: "failed", message });
      throw e;
    }
  }

  private async startManaged(config: vscode.WorkspaceConfiguration): Promise<string> {
    this.set({ kind: "starting", detail: "looking for Java" });
    const java = await releases.resolveJava(config.get<string>("javaHome") ?? "");
    const serverDir = this.serverDir;

    const { jar, version } = await this.resolveJar(config, serverDir);
    const home = path.join(serverDir, "home");
    await fs.mkdir(home, { recursive: true });
    const port = await freePort();
    const encryptionKey = await this.encryptionKey();
    const url = `http://127.0.0.1:${port}`;
    const env = await this.envStore.resolved();

    this.set({ kind: "starting", detail: `starting ${version ?? "local build"}` });
    this.log.info(`${java} -jar ${jar} (port ${port}, data under ${home})`);
    const child = spawn(java, ["-jar", jar], {
      cwd: home,
      env: {
        ...process.env,
        MINDCONNECT_ENCRYPTION_SECRET_KEY: encryptionKey,
        ...env,
        SERVER_PORT: String(port),
        // Auth is off on a local server — nothing but this machine may reach it.
        SERVER_ADDRESS: "127.0.0.1",
        // The server only takes working directories under this root, by default the
        // home directory; a project on another volume or under /tmp is as much the
        // user's as one at home.
        MINDCONNECT_TOOLS_WORKINGDIRROOT: path.parse(os.homedir()).root,
        // With auth off the server would take cross-origin calls from any web page
        // (allowed-origins defaults to *): a site open in the browser could start a
        // chat and approve its own bash call. Only the server's own origin — the
        // extension talks from Node, the Admin UI proxy server to server. Origins
        // set in the environment (a chat client on another port) come on top.
        MINDCONNECT_CORS_ALLOWEDORIGINS: [url, env.MINDCONNECT_CORS_ALLOWEDORIGINS].filter(Boolean).join(","),
      },
    });
    this.process = child;
    child.stdout?.on("data", (d: Buffer) => this.log.append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.log.append(d.toString()));
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.log.info(`Server exited (${signal ?? `code ${code}`}).`);
      const expected = signal === "SIGTERM" || signal === "SIGKILL" || code === 0 || code === 143;
      this.set(expected ? { kind: "stopped" } : { kind: "failed", message: `The server exited with code ${code}.` });
    });

    await this.waitUntilReady(url, child);
    this.log.info(`Server ready at ${url}`);
    // mindconnect.data.base-dir defaults to ./data, relative to the working directory.
    this.set({ kind: "running", url, managed: true, version, dataDir: path.join(home, "data"), namespace: env.MC_NAMESPACE || "local" });
    return url;
  }

  /**
   * The key the server encrypts stored LLM credentials with — it has no
   * default. Made once per machine and kept in VS Code's secret storage: a new
   * key would make the credentials already stored unreadable.
   */
  private async encryptionKey(): Promise<string> {
    const stored = await this.secrets.get(ENCRYPTION_KEY_SECRET);
    if (stored) return stored;
    const key = randomBytes(24).toString("base64"); // 32 characters
    await this.secrets.store(ENCRYPTION_KEY_SECRET, key);
    return key;
  }

  /** The configured local jar, else the release — downloaded after the user agreed. */
  private async resolveJar(
    config: vscode.WorkspaceConfiguration,
    serverDir: string,
  ): Promise<{ jar: string; version?: string }> {
    const local = config.get<string>("jarPath");
    if (local) {
      await fs.access(local).catch(() => {
        throw new Error(`mindconnect.server.jarPath does not exist: ${local}`);
      });
      return { jar: local };
    }
    const wanted = config.get<string>("version") || "latest";
    this.set({ kind: "starting", detail: "checking the release" });
    const version = wanted === "latest" ? await this.latestOrInstalled(serverDir) : wanted;
    const jar = releases.jarPath(serverDir, version);
    if (await exists(jar)) {
      const verified = await releases.verifyInstalled(version, jar).catch((e) => {
        // Offline: it came from Central over HTTPS; say so and go on.
        this.log.warn(`Could not check ${version} against Maven Central: ${e instanceof Error ? e.message : e}`);
        return true;
      });
      if (!verified) {
        await fs.rm(jar, { force: true });
        throw new Error(`The installed ${version} does not match Maven Central's SHA-512 and was removed — start again to download it anew.`);
      }
      return { jar, version };
    }

    const size = await releases.downloadSize(version);
    const sizeText = size ? ` (${(size / 1024 / 1024).toFixed(0)} MB)` : "";
    const choice = await vscode.window.showInformationMessage(
      `Download the MindConnect server ${version}${sizeText} from Maven Central?`,
      { modal: true, detail: `It is stored under ${serverDir} and runs locally with Java ${releases.MIN_JAVA}.` },
      "Download",
    );
    if (choice !== "Download") throw new Error("Server download declined.");

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading MindConnect ${version}`, cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        let reported = 0;
        await releases.download(version, jar, (received, total) => {
          if (!total) return;
          const percent = (received / total) * 100;
          progress.report({ increment: percent - reported, message: `${percent.toFixed(0)} %` });
          reported = percent;
        }, abort.signal);
      },
    );
    return { jar, version };
  }

  /** Newest release; offline, the newest one already downloaded. */
  private async latestOrInstalled(serverDir: string): Promise<string> {
    try {
      return await releases.latestVersion();
    } catch (e) {
      const [newest] = await releases.installedVersions(serverDir);
      if (newest) {
        this.log.warn(`Could not reach Maven Central, using the installed ${newest}.`);
        return newest;
      }
      throw e;
    }
  }

  private async waitUntilReady(url: string, child: ChildProcess): Promise<void> {
    const client = new MindconnectClient(() => url);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("The server exited during startup — see the server log.");
      if (await client.ping(AbortSignal.timeout(2_000))) return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    child.kill("SIGTERM");
    throw new Error(`The server did not answer within ${STARTUP_TIMEOUT_MS / 1000} s — see the server log.`);
  }

  private set(state: ServerState): void {
    this.current = state;
    this.render();
    this.changed.fire(state);
  }

  private render(): void {
    const s = this.current;
    switch (s.kind) {
      case "stopped":
        this.status.text = "$(circle-outline) MindConnect";
        this.status.tooltip = "MindConnect server stopped — click for actions";
        this.status.backgroundColor = undefined;
        break;
      case "starting":
        this.status.text = "$(loading~spin) MindConnect";
        this.status.tooltip = `MindConnect: ${s.detail} …`;
        this.status.backgroundColor = undefined;
        break;
      case "running":
        this.status.text = "$(pass-filled) MindConnect";
        this.status.tooltip = s.managed ? `MindConnect ${s.version ?? "local build"} at ${s.url}` : `MindConnect at ${s.url} (external)`;
        this.status.backgroundColor = undefined;
        break;
      case "failed":
        this.status.text = "$(error) MindConnect";
        this.status.tooltip = `MindConnect: ${s.message}`;
        this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}
