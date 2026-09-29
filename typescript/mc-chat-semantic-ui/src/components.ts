// The chat UI components, ported from the server's
// ai.mindconnect.chatui.ui.component.* to the browser. Same node shapes, ids
// and css classes as the server renders — so it looks like the admin UI chat —
// but every trigger is a client-side handler that calls the REST API instead
// of a server dispatch. Peripheral server machinery (StreamBus, reconnect
// buffering, deep sub-agent trees, settings/attachments dialogs, regenerate)
// is intentionally out of scope for a standalone client.
import type { UiListItem, UiNode, UiPatchOperation } from "/sui/model.js";
import { UiAppShell, UiMenu, UiMenuItem, UiList, UiItem, UiMarkdown, UiAction, UiStack, UiForm, UiField, UiText, Op } from "./model.js";
import type { Renderable } from "./model.js";
import type { Agent, Session, HistoryMessage, Approval } from "./api.js";

// ── SessionUiCommons ─────────────────────────────────────────────────────────

export const DT_FMT = (d: Date = new Date()): string =>
  d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
export const prettyJson = (x: unknown): string => {
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
};

// ── ChatShellComponent ───────────────────────────────────────────────────────
// The chat's own app shell: the conversation history in a left drawer, the
// conversation in the middle. History entries open a session (client handler).

export function chatShell(sessions: Session[], activeId: string | undefined, content: UiNode): UiNode {
  const menu = UiMenu.of("chat-menu", "Chats").side("LEFT").mode("OVERLAY").state("HIDDEN").toggle(true);
  menu.item(UiMenuItem.of("chat-new", "New chat").icon("add").invoke("chat.new"));
  menu.item(UiMenuItem.divider());
  for (const s of sessions) {
    const label = s.title && s.title.trim() ? s.title : "New chat";
    menu.item(UiMenuItem.link("chat-" + s.id, label, "#" + s.id)
      .icon("chat").badge(ago(s.startedAt)).selected(s.id === activeId)
      .invoke("session.open", s.id));
  }
  return UiAppShell.of("chat-app-shell").menu(menu).content(content).render();
}

function ago(iso?: string): string {
  if (!iso) return "";
  const minutes = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? hours + "h" : Math.floor(hours / 24) + "d";
}

// ── MessageComponent ─────────────────────────────────────────────────────────
// One message bubble: who, when, what. User messages carry delete-from-here.

export function messageItem(agentName: string, m: HistoryMessage, isUser: boolean): UiItem {
  const speaker = isUser ? "You" : agentName;
  const label = `${speaker}  [${DT_FMT()}]`;
  const css = isUser ? "user-message" : "bot-message";
  const id = "msg-" + Math.random().toString(36).slice(2);
  return UiItem.of(id, label).content(UiMarkdown.of(id + "-md", m.content ?? "").withCssClass(css));
}

// ── ApprovalCardComponent ────────────────────────────────────────────────────
// One shape for every open question: intro, collapsible params, three buttons.

export function parseApprovalContent(content?: string): { toolName: string; argsJson: string } {
  try {
    const node = JSON.parse(content ?? "{}");
    return {
      toolName: node?.name ?? "?",
      argsJson: node?.arguments ? prettyJson(node.arguments) : "{}",
    };
  } catch { return { toolName: "?", argsJson: "{}" }; }
}

export function approvalCard(callId: string, toolName: string, argsJson: string, time: string): UiListItem {
  const intro = UiMarkdown.of("approval-intro-" + callId, "The agent wants to run **`" + toolName + "`**.");
  const params = UiList.of("approval-params-list-" + callId, null).item(
    UiItem.of("approval-params-" + callId, "Parameters").collapsible("show", false)
      .content(UiMarkdown.of("approval-args-" + callId, "```json\n" + argsJson + "\n```")),
  );
  const answer = (approved: boolean, scope: string) => callId + "|" + approved + "|" + scope;
  const buttons = UiStack.of("approval-buttons-" + callId,
    UiAction.danger("approval-deny-" + callId, "Deny").invoke("approval.answer", answer(false, "once")),
    UiAction.secondary("approval-once-" + callId, "Allow once").invoke("approval.answer", answer(true, "once")),
    UiAction.primary("approval-session-" + callId, "Allow for this session").invoke("approval.answer", answer(true, "session")),
  ).direction("HORIZONTAL").gap(8);
  const body = UiStack.of("approval-body-" + callId, intro, params, buttons).withCssClass("approval-request");
  return UiItem.of("approval-" + callId, `Approval required  [${time}]`).content(body).render();
}

// ── TaskCardComponent ────────────────────────────────────────────────────────
// A tool call as a collapsible card, in one of three lifecycle states.

export class TaskCard {
  // Cards always render collapsed (client-controlled open state), so there is
  // no `open` flag — matching the server's collapsibleClient contract.
  constructor(readonly nodeId: string, private readonly header: string,
              private readonly bodyMarkdown: string) {}

  static runningTool(nodeId: string, toolName: string, args: unknown): TaskCard {
    return new TaskCard(nodeId, `⏳ ${toolName} — running…`, taskBody(prettyJson(args), null));
  }
  static doneTool(nodeId: string, toolName: string, args: unknown, result: string, durationMs: number): TaskCard {
    return new TaskCard(nodeId, `✓ ${toolName} (${Math.round(durationMs)} ms)`, taskBody(prettyJson(args), result));
  }
  static failedTool(nodeId: string, toolName: string, args: unknown, error: string, durationMs: number): TaskCard {
    return new TaskCard(nodeId, `✗ ${toolName} (${Math.round(durationMs)} ms)`, taskBody(prettyJson(args), error));
  }
  static historic(nodeId: string, header: string): TaskCard {
    return new TaskCard(nodeId, header, "");
  }

  id(): string { return this.nodeId; }

  /** Single-item list wrapper — the shape APPEND-into-list and REPLACE both accept. */
  render(): UiList {
    const item = UiItem.of(this.nodeId, "")
      .content(UiMarkdown.of(this.nodeId + "-md", this.bodyMarkdown).withCssClass("task-card-body"))
      .collapsibleClient(this.header, null);
    return UiList.of("task-wrapper-" + this.nodeId, null).item(item);
  }
}

function taskBody(inputJson: string, output: string | null): string {
  let md = "**Input**\n\n```json\n" + inputJson + "\n```";
  if (output != null && output !== "") md += "\n\n**Output**\n\n```\n" + output + "\n```";
  return md;
}

// ── MessageListComponent ─────────────────────────────────────────────────────
// The conversation list. render() builds it from history; the patch operations
// are the live stream's vocabulary (append/replace bubbles and cards).

export class MessageList {
  constructor(readonly sessionId: string, readonly agentName: string,
              private readonly history: HistoryMessage[], private readonly approvals: Approval[]) {}

  id(): string { return "msg-list-" + this.sessionId; }

  render(): UiList {
    const list = UiList.of(this.id(), this.agentName || "Chat").icon("chat").withCssClass("chat-container");
    const chats = this.history.filter((m) => m.type === "CHAT");
    if (!chats.length && !this.approvals.length) {
      list.item(UiItem.of("empty", "No messages yet")
        .description("Type a message below to start the conversation."));
    }
    for (const m of this.history) {
      if (m.type === "CHAT") {
        list.item(messageItem(this.agentName, m, m.senderType === "USER"));
      } else if (m.type === "TOOL_CALL") {
        const names = toolNames(m.content);
        if (names) list.item(TaskCard.historic("hist-" + Math.random().toString(36).slice(2), "⚙ " + names).render().getItems()[0]);
      }
    }
    for (const a of this.approvals) {
      const { toolName, argsJson } = parseApprovalContent(a.content);
      list.item(approvalCard(a.callId, a.toolName ?? toolName, argsJson, DT_FMT()));
    }
    return list;
  }

  // ── patch operations (the live stream vocabulary) ──────────────────────────

  replaceAll(): UiPatchOperation { return Op.replace(this.id(), this.render()); }

  appendUserMessage(text: string): UiPatchOperation {
    const id = "user-msg-" + Date.now();
    const wrapper = UiList.of("user-item-" + id, null).item(
      UiItem.of(id, `You  [${DT_FMT()}]`).content(UiMarkdown.of(id + "-md", text).withCssClass("user-message")));
    return Op.append(this.id(), wrapper);
  }

  appendBotPending(pendingId: string): UiPatchOperation {
    const wrapper = UiList.of("bot-pending-wrapper", null).item(
      UiItem.of(pendingId, `${this.agentName}  [${DT_FMT()}]`)
        .content(UiMarkdown.of(pendingId, "…").withCssClass("bot-message")));
    return Op.append(this.id(), wrapper);
  }

  replaceBotPending(pendingId: string, cumulative: string): UiPatchOperation {
    return Op.replace(pendingId, UiMarkdown.of(pendingId, cumulative).withCssClass("bot-message"));
  }

  appendThinking(thinkingId: string): UiPatchOperation {
    const wrapper = UiList.of("thinking-wrapper-" + thinkingId, null).item(
      UiItem.of(thinkingId, this.agentName)
        .content(UiMarkdown.of(thinkingId + "-md", "AI is thinking").withCssClass("bot-message bot-message--thinking")));
    return Op.append(this.id(), wrapper);
  }
  removeThinking(thinkingId: string): UiPatchOperation { return Op.remove("thinking-wrapper-" + thinkingId); }

  appendTaskCard(card: TaskCard): UiPatchOperation { return Op.append(this.id(), card.render()); }
  replaceTaskCard(card: TaskCard): UiPatchOperation { return Op.replace(card.id(), card.render()); }

  appendApprovalCard(card: UiListItem): UiPatchOperation {
    const wrapper = UiList.of("approval-wrapper-" + card.id, null);
    (wrapper as any).getItems().push(card);
    return Op.append(this.id(), wrapper);
  }

  appendErrorNotice(message: string): UiPatchOperation {
    const id = "turn-error-" + Date.now();
    const wrapper = UiList.of(id + "-wrapper", null).item(
      UiItem.of(id, "Error").content(UiMarkdown.of(id + "-md", "⚠️ **The turn failed:** " + message).withCssClass("bot-message error-message")));
    return Op.append(this.id(), wrapper);
  }
}

function toolNames(content?: string): string | null {
  try {
    const names = (JSON.parse(content ?? "{}").toolCalls ?? []).map((c: any) => c.name);
    return names.length ? names.join(", ") : null;
  } catch { return null; }
}

// ── ChatFormComponent ────────────────────────────────────────────────────────
// The composer: idle (editable textarea + Send) and streaming (thinking + Stop).
// Same id across states so a REPLACE morphs one into the other.

export class ChatForm {
  // One composer for the single chat window — a stable id so idle and
  // streaming states REPLACE into each other.
  static readonly ID = "chat-form";
  constructor(private readonly streaming: boolean = false) {}
  id(): string { return ChatForm.ID; }
  render(): UiNode { return this.streaming ? this.streamingForm() : this.idleForm(); }

  reset(): UiPatchOperation { return Op.replace(ChatForm.ID, this.idleForm()); }
  toStreaming(): UiPatchOperation { return Op.replace(ChatForm.ID, this.streamingForm()); }

  private idleForm(): UiNode {
    return UiForm.of(ChatForm.ID, null)
      .field(UiField.textarea("message", "Message", null).asEditable().asRequired()
        .placeholder("Ask anything …").submitOnEnter())
      .action(UiAction.icon("attach", "Attach files").icon("add").invoke("chat.attach"))
      .action(UiAction.icon("send", "Send").icon("send").style("PRIMARY").invoke("chat.send", undefined, ChatForm.ID))
      .withCssClass("chat-form").render();
  }

  private streamingForm(): UiNode {
    return UiStack.of(ChatForm.ID,
      UiText.of(ChatForm.ID + ":thinking", "AI is thinking").withCssClass("chat-thinking"),
      UiAction.danger("stop", "Stop").icon("stop").invoke("chat.stop"),
    ).direction("HORIZONTAL").withCssClass("chat-form chat-form--streaming").render();
  }
}

// ── Agent selector (in the chat window, not a separate list) ─────────────────
// The chat opens on a default agent; you pick/switch the agent here, the way
// the admin UI's composer settings do. On the /api surface an agent change
// starts a fresh chat with that agent.

export function agentBar(agents: Agent[], selectedId: string | undefined): UiNode {
  const options = agents.map((a) => ({ value: a.id, label: a.name }));
  return UiForm.of("agent-bar", null)
    .field(UiField.select("agentId", "Agent", selectedId ?? "", options).asEditable().onChangeInvoke("agent.select", "agent-bar"))
    .withCssClass("agent-bar").render();
}

// ── Chat window (buildChatPage) ──────────────────────────────────────────────
// One window: the agent selector, the conversation (or an empty hint), the
// composer. The history drawer lists past conversations.

export function chatWindow(agents: Agent[], selectedAgentId: string | undefined,
                           sessions: Session[], active: Session | undefined, agentName: string,
                           history: HistoryMessage[], approvals: Approval[], streaming: boolean): UiNode {
  const conversation: Renderable = active
    ? new MessageList(active.id, agentName, history, approvals).render()
    : UiList.of("msg-list-none", agentName || "Chat").icon("chat").withCssClass("chat-container")
        .item(UiItem.of("empty", "No messages yet").description("Type a message below to start the conversation."));
  const content = UiStack.of("chat-content",
    agentBar(agents, selectedAgentId), conversation, new ChatForm(streaming).render(),
  ).withCssClass("chat-page").render();
  return chatShell(sessions, active?.id, content);
}
