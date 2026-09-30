import * as vscode from "vscode";
import type { MindconnectClient } from "../api/client";
import { VSCODE_AGENT } from "../backchannel/provisioning";

/** What a chat keeps between turns: the server session it continues, opened for which agent, working where. */
export interface TurnMetadata {
  sessionId: string;
  /** The agent setting the session was opened for — a name or an id. */
  agent: string;
  workingDir?: string;
}

/**
 * The session a turn goes to: a new one for the configured agent, or the
 * previous one — moved to the current working directory when that changed.
 */
export async function openSession(
  client: MindconnectClient,
  previous: TurnMetadata | undefined,
  workingDir: string | undefined,
  additionalDirs: string[],
): Promise<TurnMetadata> {
  if (!previous) {
    const agent = configuredAgent();
    const { id } = await client.findAgent(agent).catch(async (e) => {
      // Without the back channel (external server) there is no vscode-assistant; its template does the job.
      if (agent !== VSCODE_AGENT) throw e;
      return client.findAgent("coding-assistant");
    });
    const session = await client.createSession(id, workingDir, additionalDirs);
    return { sessionId: session.id, agent, workingDir };
  }
  if (workingDir && workingDir !== previous.workingDir) {
    await client.changeWorkingDir(previous.sessionId, workingDir, additionalDirs);
    return { ...previous, workingDir };
  }
  return previous;
}

/** The agent setting — a name or an id; vscode-assistant unless changed. */
export function configuredAgent(): string {
  return vscode.workspace.getConfiguration("mindconnect").get<string>("agent") || VSCODE_AGENT;
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
