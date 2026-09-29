import * as vscode from "vscode";
import { MindconnectClient } from "./api/client";
import { BackChannel } from "./backchannel/backChannel";
import { registerChatParticipant } from "./chat/participant";
import { EnvStore } from "./server/envStore";
import { ServerManager } from "./server/serverManager";
import { AdminUi } from "./ui/adminUiView";
import { ServerView } from "./ui/serverView";

export function activate(context: vscode.ExtensionContext): void {
  const env = new EnvStore(context.secrets);
  const server = new ServerManager(context.globalStorageUri, context.secrets, env);
  const client = new MindconnectClient(() => {
    if (server.url) return server.url;
    throw new Error("The MindConnect server is not running.");
  });

  const backChannel = new BackChannel(server, client);
  const adminUi = new AdminUi(server, context.extensionUri);
  const serverView = new ServerView(server, env, server.serverDir);

  context.subscriptions.push(
    server,
    backChannel,
    adminUi,
    serverView,
    vscode.window.registerWebviewViewProvider(ServerView.viewId, serverView),
    vscode.window.registerWebviewViewProvider(AdminUi.viewId, adminUi, { webviewOptions: { retainContextWhenHidden: true } }),
    registerChatParticipant(server, client, backChannel),
    // An explicit start — unlike the chat, it does not wait for autoStart.
    vscode.commands.registerCommand("mindconnect.server.start", () => withFeedback(server, () => server.start())),
    vscode.commands.registerCommand("mindconnect.server.restart", () => withFeedback(server, () => server.restart())),
    vscode.commands.registerCommand("mindconnect.server.stop", () => server.stop()),
    vscode.commands.registerCommand("mindconnect.server.showLog", () => server.showLog()),
    vscode.commands.registerCommand("mindconnect.openAdminUi", async () => {
      if (await withFeedback(server, () => server.start())) await adminUi.openInEditor();
    }),
    vscode.commands.registerCommand("mindconnect.adminUi.openInEditor", () => adminUi.openInEditor()),
    vscode.commands.registerCommand("mindconnect.adminUi.reload", () => adminUi.reload()),
    vscode.commands.registerCommand("mindconnect.adminUi.openInBrowser", async () => {
      const url = await withFeedback(server, () => server.start());
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("mindconnect.showView", () => vscode.commands.executeCommand("workbench.view.extension.mindconnect")),
    vscode.commands.registerCommand("mindconnect.selectAgent", () => selectAgent(server, client)),
    vscode.commands.registerCommand("mindconnect.showMenu", () => showMenu(server)),
  );
}

export function deactivate(): void {
  // ServerManager.dispose (a subscription) stops the managed server.
}

async function withFeedback(server: ServerManager, run: () => Promise<string>): Promise<string | undefined> {
  try {
    return await run();
  } catch (e) {
    const pick = await vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e), "Show Log");
    if (pick) server.showLog();
    return undefined;
  }
}

async function selectAgent(server: ServerManager, client: MindconnectClient): Promise<void> {
  if (!(await withFeedback(server, () => server.ensureRunning()))) return;
  const current = vscode.workspace.getConfiguration("mindconnect").get<string>("agent");
  const agents = await client.listAgents();
  const pick = await vscode.window.showQuickPick(
    agents.map((a) => ({ label: a.name, description: a.name === current || a.id === current ? "current" : undefined, detail: a.description })),
    { title: "MindConnect agent for @mindconnect", matchOnDetail: true },
  );
  if (pick) {
    await vscode.workspace.getConfiguration("mindconnect").update("agent", pick.label, vscode.ConfigurationTarget.Global);
  }
}

/** The status bar item's menu — the actions that make sense in the current state. */
async function showMenu(server: ServerManager): Promise<void> {
  const running = server.state.kind === "running";
  const items: (vscode.QuickPickItem & { command: string })[] = [
    running
      ? { label: "$(debug-stop) Stop Server", command: "mindconnect.server.stop" }
      : { label: "$(play) Start Server", command: "mindconnect.server.start" },
    ...(running ? [{ label: "$(debug-restart) Restart Server", command: "mindconnect.server.restart" }] : []),
    { label: "$(layout-sidebar-left) Show MindConnect View", description: "server settings, jar, environment", command: "mindconnect.showView" },
    { label: "$(window) Open Admin UI", description: "LLM configs, agents, skills", command: "mindconnect.openAdminUi" },
    { label: "$(hubot) Select Agent", command: "mindconnect.selectAgent" },
    { label: "$(output) Show Server Log", command: "mindconnect.server.showLog" },
    { label: "$(comment-discussion) Open Chat", command: "workbench.action.chat.open" },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: "MindConnect" });
  if (pick) await vscode.commands.executeCommand(pick.command, pick.command === "workbench.action.chat.open" ? "@mindconnect " : undefined);
}
