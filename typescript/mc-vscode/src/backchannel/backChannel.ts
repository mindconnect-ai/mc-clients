import * as vscode from "vscode";
import type { MindconnectClient } from "../api/client";
import type { ChatHooks } from "../chat/participant";
import type { ServerManager, ServerState } from "../server/serverManager";
import { ProposalManager } from "./proposals";
import { ensureVsCodeAgent, registerToolServer } from "./provisioning";
import { VsCodeToolServer } from "./toolServer";

/**
 * Sets the back channel up whenever a managed server comes up: the tool
 * server runs, the gateway knows it, vscode-assistant exists. A failure here
 * is logged, not fatal — the chat falls back to coding-assistant, which
 * writes files itself.
 */
export class BackChannel implements ChatHooks, vscode.Disposable {
  private readonly proposals = new ProposalManager();
  private readonly tools: VsCodeToolServer;
  private readonly subscription: vscode.Disposable;
  private setup: Promise<void> = Promise.resolve();
  private chatDir: string | undefined;

  constructor(private readonly server: ServerManager, private readonly client: MindconnectClient) {
    this.tools = new VsCodeToolServer(this.proposals, server.log);
    this.tools.workingDir = () => this.chatDir;
    this.subscription = server.onDidChangeState((state) => {
      if (state.kind === "running" && state.managed) this.setup = this.provision(state);
    });
  }

  ready(): Promise<void> {
    return this.setup;
  }

  workingDirChanged(dir: string | undefined): void {
    this.chatDir = dir;
  }

  dispose(): void {
    this.subscription.dispose();
    this.tools.dispose();
    this.proposals.dispose();
  }

  private async provision(state: Extract<ServerState, { kind: "running"; managed: true }>): Promise<void> {
    const log = this.server.log;
    try {
      const url = await this.tools.start();
      await registerToolServer(state.dataDir, state.namespace, url, this.tools.token);
      await ensureVsCodeAgent(this.client);
      log.info("Back channel ready: vscode-assistant proposes changes as diffs.");
    } catch (e) {
      log.error(`Back channel not available: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
