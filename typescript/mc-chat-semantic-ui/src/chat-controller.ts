// The client-side twin of the server's ChatUiController.runTurnStream event
// loop: consume the chat SSE and translate each StreamEventFrame into the same
// patches the server would push — bot-pending bubble on the first token,
// cumulative-text replaces after, per-task cards, approval cards, and a
// rebuild-from-history on done. Applied through the SuiEventBus.
import type { SuiEventBus } from "/sui/eventbus.js";
import type { Frame } from "./api.js";
import { MessageList, ChatForm, TaskCard, approvalCard, DT_FMT } from "./components.js";

interface LiveTask { nodeId: string; name: string; input: unknown; }

export class ChatController {
  private cumulative = "";
  private pendingAppended = false;
  private readonly pendingId: string;
  private readonly thinkingId: string;
  private readonly liveTasks = new Map<string, LiveTask>();

  constructor(
    private readonly bus: SuiEventBus,
    private readonly list: MessageList,
    private readonly form: ChatForm,
    sessionId: string,
    private readonly onFinished: () => void,
  ) {
    this.pendingId = "bot-pending-" + sessionId;
    this.thinkingId = "bot-thinking-" + sessionId;
  }

  /** Echo the user's message, show the thinking indicator, lock the composer. */
  start(text: string): void {
    this.bus.applyPatch({ patches: [
      this.list.appendUserMessage(text),
      this.list.appendThinking(this.thinkingId),
      this.form.toStreaming(),
    ] });
  }

  /** One SSE frame → its patch. Mirrors the server's event switch. */
  onFrame(f: Frame, indent = false): void {
    if (f.type === "sub_agent_event" && f.inner) { this.onFrame(f.inner, true); return; }
    switch (f.type) {
      case "token": {
        if (indent) break;
        this.cumulative += f.text ?? "";
        if (!this.pendingAppended) {
          this.bus.applyPatch({ patches: [
            this.list.removeThinking(this.thinkingId),
            this.list.appendBotPending(this.pendingId),
          ] });
          this.pendingAppended = true;
        }
        this.bus.applyPatch({ patches: [this.list.replaceBotPending(this.pendingId, this.cumulative)] });
        break;
      }
      case "tool_call_started": {
        const nodeId = "tool-" + Math.random().toString(36).slice(2);
        this.liveTasks.set("tool:" + (f.toolName ?? ""), { nodeId, name: f.toolName ?? "?", input: f.arguments });
        this.bus.applyPatch({ patches: [this.list.appendTaskCard(TaskCard.runningTool(nodeId, f.toolName ?? "?", f.arguments))] });
        break;
      }
      case "tool_call_result":
      case "tool_call_failed": {
        const t = this.liveTasks.get("tool:" + (f.toolName ?? ""));
        if (!t) break;
        const card = f.type === "tool_call_failed"
          ? TaskCard.failedTool(t.nodeId, t.name, t.input, f.error ?? "", f.durationMs ?? 0)
          : TaskCard.doneTool(t.nodeId, t.name, t.input, f.result ?? "", f.durationMs ?? 0);
        this.bus.applyPatch({ patches: [this.list.replaceTaskCard(card)] });
        this.liveTasks.delete("tool:" + (f.toolName ?? ""));
        break;
      }
      case "sub_agent_started": {
        const nodeId = "sub-" + (f.taskId ?? Math.random().toString(36).slice(2));
        this.liveTasks.set("sub:" + (f.agentName ?? ""), { nodeId, name: f.agentName ?? "Sub-Agent", input: f.text });
        this.bus.applyPatch({ patches: [this.list.appendTaskCard(
          TaskCard.runningTool(nodeId, "↳ " + (f.agentName ?? "Sub-Agent"), f.text))] });
        break;
      }
      case "sub_agent_done":
      case "sub_agent_error": {
        const t = this.liveTasks.get("sub:" + (f.agentName ?? ""));
        if (!t) break;
        const card = f.type === "sub_agent_error"
          ? TaskCard.failedTool(t.nodeId, "↳ " + t.name, t.input, f.error ?? "", 0)
          : TaskCard.doneTool(t.nodeId, "↳ " + t.name, t.input, f.finalText ?? "", 0);
        this.bus.applyPatch({ patches: [this.list.replaceTaskCard(card)] });
        this.liveTasks.delete("sub:" + (f.agentName ?? ""));
        break;
      }
      case "approval_requested": {
        // The server overloads `text` with the callId.
        const argsJson = f.arguments ? JSON.stringify(f.arguments, null, 2) : "{}";
        this.bus.applyPatch({ patches: [
          this.list.appendApprovalCard(approvalCard(f.text!, f.toolName ?? "?", argsJson, DT_FMT())),
        ] });
        break;
      }
      case "done":
        this.finish();
        break;
      case "error":
        this.bus.applyPatch({ patches: [this.list.appendErrorNotice(f.error ?? f.text ?? "Error")] });
        this.finish();
        break;
    }
  }

  private finish(): void {
    this.bus.applyPatch({ patches: [this.form.reset()] });
    this.onFinished();
  }
}
