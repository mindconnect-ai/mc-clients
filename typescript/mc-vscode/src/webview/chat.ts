/*
 * The chat window's page: draws the conversation the extension streams to it
 * (see chat/chatView.ts for the messages) and sends what the user types
 * back. Markdown through marked, sanitized with DOMPurify — the text comes
 * from a model. Styled with VS Code's own colour variables, so it wears the
 * editor's theme.
 */
import DOMPurify from "dompurify";
import { marked } from "marked";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();

interface Frame {
  type: string;
  text?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  finalText?: string;
  error?: string;
  agentName?: string;
  inner?: Frame;
}

const style = `
  :root { --gap: 8px; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); display: flex; flex-direction: column; height: 100vh; }
  #head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #0000); font-size: 11px; color: var(--vscode-descriptionForeground); flex: none; }
  #head .agent { color: var(--vscode-foreground); cursor: pointer; }
  #head .agent:hover { text-decoration: underline; }
  #head .spacer { flex: 1; }
  #log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 100%; line-height: 1.45; word-wrap: break-word; }
  .msg.user { align-self: flex-end; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 6px 10px; white-space: pre-wrap; max-width: 92%; }
  .msg.user .file { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .msg.bot { padding: 0 2px; }
  .msg.bot p { margin: 0 0 8px; }
  .msg.bot pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .msg.bot code { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
  .msg.bot pre code { padding: 0; background: none; }
  .msg.bot a { color: var(--vscode-textLink-foreground); }
  .msg.bot table { border-collapse: collapse; } .msg.bot td, .msg.bot th { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; }
  .msg.bot blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border); margin: 0 0 8px; padding-left: 8px; color: var(--vscode-descriptionForeground); }
  .card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px; font-size: 12px; overflow: hidden; }
  .card > summary { padding: 4px 8px; cursor: pointer; list-style: none; display: flex; gap: 6px; align-items: center; color: var(--vscode-descriptionForeground); }
  .card > summary::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-editorWarning-foreground); flex: none; }
  .card.done > summary::before { background: var(--vscode-testing-iconPassed); }
  .card.failed > summary::before { background: var(--vscode-errorForeground); }
  .card pre { margin: 0; padding: 6px 8px; border-top: 1px solid var(--vscode-panel-border, #444); background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; max-height: 240px; overflow: auto; }
  .approval { border: 1px solid var(--vscode-editorWarning-foreground); border-radius: 4px; padding: 8px; font-size: 12px; }
  .approval pre { max-height: 160px; overflow: auto; font-size: 11px; margin: 6px 0; }
  .approval .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .thinking { color: var(--vscode-descriptionForeground); font-size: 12px; font-style: italic; }
  .error { color: var(--vscode-errorForeground); font-size: 12px; white-space: pre-wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 2px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  #composer { flex: none; padding: 8px 10px 10px; border-top: 1px solid var(--vscode-panel-border, #0000); display: flex; flex-direction: column; gap: 6px; }
  #context { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); min-height: 16px; }
  #context input { margin: 0; }
  #context .name { font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #input { width: 100%; box-sizing: border-box; resize: none; min-height: 58px; max-height: 200px; padding: 6px 8px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); }
  #buttons { display: flex; gap: 6px; justify-content: flex-end; }
  #empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 10px; }
`;

const $ = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const app = document.getElementById("app")!;
app.append(Object.assign(document.createElement("style"), { textContent: style }));

const head = $("div");
head.id = "head";
const agentEl = $("span", "agent", "…");
agentEl.title = "Pick the agent";
agentEl.addEventListener("click", () => vscode.postMessage({ type: "selectAgent" }));
const serverEl = $("span", "", "");
head.append(agentEl, $("span", "spacer"), serverEl);

const log = $("div");
log.id = "log";
const empty = $("div", "", "Ask MindConnect anything about the file or folder you are in. Enter sends, Shift+Enter is a new line.");
empty.id = "empty";
log.append(empty);

const composer = $("div");
composer.id = "composer";
const context = $("label");
context.id = "context";
const withContext = $<HTMLInputElement>("input");
withContext.type = "checkbox";
withContext.checked = true;
const fileName = $("span", "name", "no file");
context.append(withContext, $("span", "", "Include"), fileName);
const input = $<HTMLTextAreaElement>("textarea");
input.id = "input";
input.placeholder = "Ask anything …";
const buttons = $("div");
buttons.id = "buttons";
const newBtn = $<HTMLButtonElement>("button", "secondary", "New chat");
const stopBtn = $<HTMLButtonElement>("button", "secondary", "Stop");
const sendBtn = $<HTMLButtonElement>("button", "", "Send");
buttons.append(newBtn, stopBtn, sendBtn);
composer.append(context, input, buttons);
app.append(head, log, composer);

let busy = false;
let bot: HTMLElement | undefined;   // the assistant message being streamed
let botText = "";
let thinking: HTMLElement | undefined;
const live = new Map<string, HTMLDetailsElement>();

function render(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
}

function scroll(): void {
  log.scrollTop = log.scrollHeight;
}

function add(el: HTMLElement): void {
  empty.remove();
  log.append(el);
  scroll();
}

function send(): void {
  const text = input.value.trim();
  if (!text || busy) return;
  vscode.postMessage({ type: "send", text, withContext: withContext.checked });
  input.value = "";
  input.style.height = "";
}

sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
newBtn.addEventListener("click", () => vscode.postMessage({ type: "new" }));
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
input.addEventListener("input", () => {
  input.style.height = "";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
});

function setBusy(b: boolean): void {
  busy = b;
  sendBtn.disabled = b;
  stopBtn.disabled = !b;
  if (!b) thinking?.remove();
}

function finishBot(): void {
  if (bot && botText) bot.innerHTML = render(botText);
  bot = undefined;
  botText = "";
  thinking?.remove();
  thinking = undefined;
}

function card(key: string, title: string, input?: unknown): HTMLDetailsElement {
  const d = $<HTMLDetailsElement>("details", "card");
  const s = $("summary", "", title);
  d.append(s);
  if (input !== undefined) d.append($("pre", "", typeof input === "string" ? input : JSON.stringify(input, null, 2)));
  live.set(key, d);
  add(d);
  return d;
}

function settle(key: string, ok: boolean, output?: string, ms?: number): void {
  const d = live.get(key);
  if (!d) return;
  live.delete(key);
  d.classList.add(ok ? "done" : "failed");
  if (ms) d.querySelector("summary")!.append($("span", "", ` · ${(ms / 1000).toFixed(1)} s`));
  if (output) d.append($("pre", "", output.length > 4000 ? output.slice(0, 4000) + "\n…" : output));
}

function onFrame(f: Frame, fromSubAgent = false): void {
  switch (f.type) {
    case "asking_llm":
      if (!thinking) {
        thinking = $("div", "thinking", "Thinking …");
        add(thinking);
      }
      return;
    case "token":
      if (fromSubAgent || !f.text) return;
      thinking?.remove();
      thinking = undefined;
      if (!bot) {
        bot = $("div", "msg bot");
        add(bot);
      }
      botText += f.text;
      bot.innerHTML = render(botText);
      scroll();
      return;
    case "tool_call_started": {
      const t = f.toolName ?? "tool";
      const reviewed = t === "vscode_edit_file" || t === "vscode_write_file";
      card("tool:" + t, reviewed ? `${t} — review the diff in the editor` : t, f.arguments);
      return;
    }
    case "tool_call_result":
      settle("tool:" + (f.toolName ?? "tool"), true, f.result, f.durationMs);
      return;
    case "tool_call_failed":
      settle("tool:" + (f.toolName ?? "tool"), false, f.error, f.durationMs);
      return;
    case "sub_agent_started":
      card("sub:" + (f.agentName ?? ""), `↳ ${f.agentName ?? "sub-agent"}`, f.text);
      return;
    case "sub_agent_done":
      settle("sub:" + (f.agentName ?? ""), true, f.finalText);
      return;
    case "sub_agent_error":
      settle("sub:" + (f.agentName ?? ""), false, f.error);
      return;
    case "sub_agent_event":
      if (f.inner) onFrame(f.inner, true);
      return;
    case "approval_requested":
      approval(f);
      return;
    case "error":
      finishBot();
      add($("div", "error", f.error ?? f.text ?? "Error"));
      return;
    case "done":
      finishBot();
      return;
  }
}

function approval(f: Frame): void {
  const callId = f.text;
  if (!callId) return;
  const box = $("div", "approval");
  box.append($("div", "", `${f.toolName ?? "A tool"} asks for permission`));
  if (f.arguments) box.append($("pre", "", JSON.stringify(f.arguments, null, 2)));
  const row = $("div", "row");
  const answer = (approved: boolean, scope: "once" | "session", label: string) => {
    vscode.postMessage({ type: "approval", callId, approved, scope });
    box.replaceChildren($("div", "", `${f.toolName ?? "Tool"}: ${label}`));
  };
  const once = $<HTMLButtonElement>("button", "", "Allow once");
  once.addEventListener("click", () => answer(true, "once", "allowed once"));
  const session = $<HTMLButtonElement>("button", "secondary", "Allow for this session");
  session.addEventListener("click", () => answer(true, "session", "allowed for this session"));
  const deny = $<HTMLButtonElement>("button", "secondary", "Deny");
  deny.addEventListener("click", () => answer(false, "once", "denied"));
  row.append(once, session, deny);
  box.append(row);
  add(box);
}

window.addEventListener("message", ({ data }) => {
  switch (data.type) {
    case "state":
      agentEl.textContent = data.agent;
      serverEl.textContent = data.server === "running" ? "server running" : data.server === "starting" ? "server starting …" : "server stopped";
      fileName.textContent = data.file ?? "no file open";
      setBusy(data.busy);
      return;
    case "reset":
      log.replaceChildren(empty);
      live.clear();
      bot = undefined;
      botText = "";
      return;
    case "user": {
      finishBot();
      const m = $("div", "msg user");
      if (data.file) m.append($("span", "file", data.file));
      m.append(document.createTextNode(data.text));
      add(m);
      setBusy(true);
      return;
    }
    case "frame":
      onFrame(data.frame);
      return;
    case "done":
      finishBot();
      if (data.error) add($("div", "error", data.error));
      setBusy(false);
      input.focus();
      return;
  }
});

setBusy(false);
vscode.postMessage({ type: "ready" });
