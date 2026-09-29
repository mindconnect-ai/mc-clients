// Bootstraps the Semantic UI renderer, installs the Markdown extension, and
// wires the client handlers that drive the ported chat components against the
// REST API. There is no agent list — the app opens straight into one chat
// window and the agent is chosen from the selector inside it (mirroring the
// admin UI, where the composer settings pick the agent). The turn is rendered
// from the chat SSE by ChatController — the browser-side twin of runTurnStream.
import "/sui/sui.css";
import "/sui/chat-ui.css";
import "./app.css";
import { createDefaultRenderer } from "/sui/renderer.js";
import { install as installMarkdown } from "/sui/markdown/extension.js";
import { SuiEventBus } from "/sui/eventbus.js";
import type { BehaviorContext } from "/sui/eventbus.js";
import * as api from "./api.js";
import type { Agent, Session } from "./api.js";
import { chatWindow, MessageList, ChatForm } from "./components.js";
import { Op } from "./model.js";
import { ChatController } from "./chat-controller.js";

const root = document.getElementById("sui-root")!;
const renderer = createDefaultRenderer().attach(root);
void installMarkdown(renderer);
const bus = new SuiEventBus(renderer, root);
bus.setHistoryEnabled(false);
bus.setLoadingPolicy("manual");

// ── state ──────────────────────────────────────────────────────────────────

let agents: Agent[] = [];
let agentId: string | undefined;      // the currently selected agent
let sessions: Session[] = [];         // conversations of the selected agent
let session: Session | undefined;     // the open conversation
let streaming = false;

const agentName = () => agents.find((a) => a.id === agentId)?.name ?? "Chat";
const toast = (level: "INFO" | "SUCCESS" | "WARN" | "ERROR", message: string, durationMs = 3000) =>
  bus.applyPatch({ patches: [], toasts: [{ level, message, durationMs }] });

// ── rendering ────────────────────────────────────────────────────────────────

async function renderWindow(): Promise<void> {
  let history: api.HistoryMessage[] = [];
  let approvals: api.Approval[] = [];
  if (session) {
    [history, approvals] = await Promise.all([api.history(session.id), api.openApprovals(session.id)]);
  }
  renderer.mount(chatWindow(agents, agentId, sessions, session, agentName(), history, approvals, streaming));
}

async function refreshSessions(): Promise<void> {
  sessions = agentId ? await api.listSessions(agentId) : [];
}

// ── handlers ────────────────────────────────────────────────────────────────

/** Switch the agent from the in-chat selector: show that agent's newest
 *  conversation, or an empty one to start fresh. */
bus.registerClientHandler("agent.select", async (ctx: BehaviorContext) => {
  const picked = String((ctx.payload as any)?.agentId ?? "");
  if (!picked || picked === agentId) return;
  agentId = picked;
  await refreshSessions();
  session = sessions[0];
  await renderWindow();
});

bus.registerClientHandler("session.open", async (ctx: BehaviorContext) => {
  session = sessions.find((s) => s.id === ctx.trigger.url);
  await renderWindow();
});

bus.registerClientHandler("chat.new", async () => {
  if (!agentId) return;
  const created = await api.createSession(agentId);
  await refreshSessions();
  session = sessions.find((s) => s.id === created.id) ?? created;
  await renderWindow();
});

bus.registerClientHandler("chat.send", async (ctx: BehaviorContext) => {
  const message = String((ctx.payload as any)?.message ?? "").trim();
  if (!message || !agentId || streaming) return;
  if (!session) { session = await api.createSession(agentId); await refreshSessions(); await renderWindow(); }
  const list = new MessageList(session!.id, agentName(), [], []);
  const form = new ChatForm();
  const controller = new ChatController(bus, list, form, session!.id, () => { streaming = false; });
  streaming = true;
  controller.start(message);
  try {
    await api.chat(session!.id, message, (f) => controller.onFrame(f));
  } catch (e) {
    bus.applyPatch({ patches: [list.appendErrorNotice(String((e as Error).message)), form.reset()] });
    streaming = false;
  }
});

bus.registerClientHandler("chat.stop", async () => {
  if (!session) return;
  await fetch(`/api/sessions/${session.id}/chat`, { method: "DELETE", credentials: "include" });
  bus.applyPatch({ patches: [new ChatForm().reset()] });
  streaming = false;
});

bus.registerClientHandler("approval.answer", async (ctx: BehaviorContext) => {
  const [callId, approved, scope] = String(ctx.trigger.url).split("|");
  if (!session) return;
  try {
    await api.answerApproval(session.id, callId, approved === "true", scope);
    bus.applyPatch({ patches: [Op.remove("approval-" + callId)] });
  } catch (e) {
    toast("ERROR", String((e as Error).message), 4000);
  }
});

// File upload: the composer's + opens a hidden input; the file goes to the
// session's workspace where the agent can read it.
const fileInput = document.getElementById("file-input") as HTMLInputElement;
bus.registerClientHandler("chat.attach", () => { if (session) fileInput.click(); });
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file || !session) return;
  try {
    const res = await api.uploadFile(session.id, file);
    toast(res.ok ? "SUCCESS" : "ERROR", res.ok ? `Uploaded ${file.name}` : `Upload failed (${res.status})`);
  } catch (e) {
    toast("ERROR", `Upload failed: ${(e as Error).message}`);
  }
});

// ── boot ────────────────────────────────────────────────────────────────────

(async () => {
  agents = await api.listAgents();
  agentId = agents[0]?.id;
  await refreshSessions();
  session = sessions[0];
  await renderWindow();
})().catch((e) => toast("ERROR", "API unreachable: " + e.message, 0));
