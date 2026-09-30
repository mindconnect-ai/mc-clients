import * as vscode from "vscode";
import type { ApprovalScope, Frame, MindconnectClient } from "../api/client";
import { collectContext } from "../context/editorContext";
import { configuredAgent, message, openSession, TurnMetadata } from "./session";
import type { ServerManager } from "../server/serverManager";

/**
 * @mindconnect in the VS Code chat. Each VS Code chat maps to one server
 * session: the session id rides along in the result metadata of every answer
 * and is read back from the chat history on the next turn. The editor context
 * goes in front of every message, the session's working directory follows the
 * workspace folder of the active file.
 */
export interface ChatHooks {
  /** Resolves once the back channel is set up for the running server — the default agent depends on it. */
  ready(): Promise<void>;
  /** The chat's working directory, for the VS Code tools' relative paths. */
  workingDirChanged(dir: string | undefined): void;
}

export function registerChatParticipant(
  server: ServerManager,
  client: MindconnectClient,
  hooks: ChatHooks,
  extensionUri: vscode.Uri,
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant("mindconnect.chat", async (request, chat, stream, token) => {
    if (request.command === "agent") {
      await vscode.commands.executeCommand("mindconnect.selectAgent");
      stream.markdown(`New chats talk to **${configuredAgent()}**. Start one with \`@mindconnect\`.`);
      return {};
    }

    if (server.state.kind !== "running") stream.progress("Starting the MindConnect server …");
    try {
      await server.ensureRunning();
      await hooks.ready();
    } catch (e) {
      stream.button({ command: "mindconnect.server.showLog", title: "Show Server Log" });
      return { errorDetails: { message: message(e) } };
    }

    const context = await collectContext(request.references);
    const previous = request.command === "new" ? undefined : lastTurn(chat);
    let turn: TurnMetadata;
    try {
      turn = await openSession(client, previous, context.workingDir, context.additionalDirs);
    } catch (e) {
      return { errorDetails: { message: message(e) } };
    }
    if (request.command === "new" && !request.prompt.trim()) {
      stream.markdown(`Started a new session with **${turn.agent}**${turn.workingDir ? ` in \`${turn.workingDir}\`` : ""}.`);
      return { metadata: turn };
    }

    hooks.workingDirChanged(turn.workingDir);
    for (const uri of context.used) stream.reference(uri);

    const abort = new AbortController();
    const cancelled = token.onCancellationRequested(() => {
      abort.abort();
      client.cancel(turn.sessionId).catch(() => undefined);
    });
    let failure: string | undefined;
    const onFrame = (frame: Frame) => {
      failure = render(frame, stream, client, turn.sessionId) ?? failure;
    };
    try {
      try {
        await client.chat(turn.sessionId, context.prompt + request.prompt, onFrame, abort.signal);
      } catch (e) {
        // The session is gone (deleted in the Admin UI, other data directory): start over once.
        if (!/HTTP 404/.test(message(e))) throw e;
        turn = await openSession(client, undefined, context.workingDir, context.additionalDirs);
        await client.chat(turn.sessionId, context.prompt + request.prompt, onFrame, abort.signal);
      }
    } catch (e) {
      if (!token.isCancellationRequested) failure = message(e);
    } finally {
      cancelled.dispose();
    }
    return failure ? { errorDetails: { message: failure }, metadata: turn } : { metadata: turn };
  });
  participant.iconPath = {
    light: vscode.Uri.joinPath(extensionUri, "media", "logo-light.svg"),
    dark: vscode.Uri.joinPath(extensionUri, "media", "logo-dark.svg"),
  };
  return participant;
}

/** The previous turn's session when it ran the agent that is configured now. */
function lastTurn(chat: vscode.ChatContext): TurnMetadata | undefined {
  for (let i = chat.history.length - 1; i >= 0; i--) {
    const entry = chat.history[i];
    if (entry instanceof vscode.ChatResponseTurn && entry.participant === "mindconnect.chat") {
      const meta = entry.result.metadata as TurnMetadata | undefined;
      if (meta?.sessionId) return meta.agent === configuredAgent() ? meta : undefined;
    }
  }
  return undefined;
}

/** The VS Code tools that wait on the user's diff review. */
const REVIEWED_TOOLS = new Set(["vscode_edit_file", "vscode_write_file"]);

/** Shows one frame; returns an error message when the frame reports the turn failed. */
function render(frame: Frame, stream: vscode.ChatResponseStream, client: MindconnectClient, sessionId: string): string | undefined {
  switch (frame.type) {
    case "token":
      if (frame.text) stream.markdown(frame.text);
      return undefined;
    case "asking_llm":
      stream.progress("Thinking …");
      return undefined;
    case "tool_call_started":
      stream.progress(REVIEWED_TOOLS.has(frame.toolName ?? "")
        ? "Waiting for your review of the proposed change — Accept or Reject in the diff …"
        : `Running ${frame.toolName ?? "a tool"} …`);
      return undefined;
    case "tool_call_failed":
      stream.markdown(`\n\n> ⚠️ \`${frame.toolName}\` failed: ${frame.error ?? "unknown error"}\n\n`);
      return undefined;
    case "sub_agent_started":
      stream.progress(`${frame.agentName ?? "A sub-agent"} is working …`);
      return undefined;
    case "sub_agent_event":
      // A sub-agent's own tokens are its working notes; only its progress is shown here.
      if (frame.inner?.type === "tool_call_started") stream.progress(`${frame.agentName ?? "Sub-agent"}: ${frame.inner.toolName} …`);
      return undefined;
    case "approval_requested":
      // The turn waits on the server until the call is answered; the stream stays open meanwhile.
      askApproval(frame, client, sessionId).catch((e) => void vscode.window.showErrorMessage(message(e)));
      return undefined;
    case "error":
      return frame.error ?? frame.text ?? "The agent reported an error.";
    default:
      return undefined;
  }
}

async function askApproval(frame: Frame, client: MindconnectClient, sessionId: string): Promise<void> {
  const callId = frame.text;
  if (!callId) return;
  const args = frame.arguments ? JSON.stringify(frame.arguments, null, 2) : "";
  const choice = await vscode.window.showWarningMessage(
    `MindConnect wants to run ${frame.toolName ?? "a tool"}.`,
    { modal: true, detail: args.length > 1500 ? `${args.slice(0, 1500)}…` : args },
    "Allow once",
    "Allow for this session",
    "Deny",
  );
  const scope: ApprovalScope = choice === "Allow for this session" ? "session" : "once";
  const approved = choice === "Allow once" || choice === "Allow for this session";
  await client.answerApproval(sessionId, callId, approved, scope);
}
