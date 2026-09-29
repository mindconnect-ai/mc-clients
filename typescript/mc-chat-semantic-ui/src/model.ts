// A thin fluent builder layer over the Semantic UI node model, mirroring the
// server's `ai.mindconnect.ui.model.*` Java API so the ported chat components
// read the same on the client. Each builder produces the plain UiNode literal
// the renderer consumes; `render()` returns it.
//
// The one deliberate difference from the server: triggers are client-side
// INVOKE handlers (UiTrigger.invoke) instead of server dispatch/stream/api —
// this client builds the nodes AND talks to the REST API itself.
import type {
  UiNode, UiList as UiListNode, UiListItem, UiText as UiTextNode, UiStack as UiStackNode,
  UiForm as UiFormNode, UiField as UiFieldNode, UiAction as UiActionNode, UiTrigger,
  UiMenu as UiMenuNode, UiMenuItem as UiMenuItemNode, UiAppShell as UiAppShellNode,
  UiLink as UiLinkNode, UiPatchOperation, ActionStyle,
} from "/sui/model.js";

/** A value that is already a node, or a builder that renders to one. */
export type Renderable = UiNode | { render(): UiNode };
const node = (r: Renderable): UiNode => (typeof (r as any).render === "function" ? (r as any).render() : r) as UiNode;

// ── Triggers ────────────────────────────────────────────────────────────────

export const UiTriggerB = {
  /** Run a registered client handler; `url` and `payload` (a form id) are passed through. */
  invoke: (handler: string, url?: string, payload?: string): UiTrigger =>
    ({ behavior: "INVOKE", handler, url, payload }),
};

// ── Markdown (ext-markdown node) ─────────────────────────────────────────────

export class UiMarkdown {
  private n: { type: "markdown"; id: string; content: string; cssClass?: string };
  private constructor(id: string, content: string) { this.n = { type: "markdown", id, content }; }
  static of(id: string, content: string): UiMarkdown { return new UiMarkdown(id, content); }
  withCssClass(c: string): UiMarkdown { this.n.cssClass = c; return this; }
  render(): UiNode { return this.n as unknown as UiNode; }
}

// ── Text ─────────────────────────────────────────────────────────────────────

export class UiText {
  private n: UiTextNode;
  private constructor(id: string, text: string) { this.n = { type: "text", id, text }; }
  static of(id: string, text: string): UiText { return new UiText(id, text); }
  withCssClass(c: string): UiText { this.n.cssClass = c; return this; }
  render(): UiTextNode { return this.n; }
}

// ── Action ───────────────────────────────────────────────────────────────────

export class UiAction {
  private n: UiActionNode;
  private constructor(id: string, label: string) { this.n = { type: "action", id, label }; }
  static icon(id: string, label: string): UiAction { return new UiAction(id, label).appearance("ICON"); }
  static primary(id: string, label: string): UiAction { return new UiAction(id, label).style("PRIMARY"); }
  static secondary(id: string, label: string): UiAction { return new UiAction(id, label).style("SECONDARY"); }
  static danger(id: string, label: string): UiAction { return new UiAction(id, label).style("DANGER"); }
  icon(name: string): UiAction { this.n.icon = name; return this; }
  style(s: ActionStyle): UiAction { this.n.style = s; return this; }
  appearance(a: UiActionNode["appearance"]): UiAction { this.n.appearance = a; return this; }
  confirm(text: string): UiAction { this.n.confirm = text; return this; }
  withCssClass(c: string): UiAction { (this.n as { cssClass?: string }).cssClass = c; return this; }
  onClick(t: UiTrigger): UiAction { this.n.onClick = t; return this; }
  /** Client wiring: run a handler (the client's answer to server dispatch/stream). */
  invoke(handler: string, url?: string, payload?: string): UiAction {
    this.n.onClick = UiTriggerB.invoke(handler, url, payload); return this;
  }
  render(): UiActionNode { return this.n; }
}

// ── Stack ────────────────────────────────────────────────────────────────────

export class UiStack {
  private n: UiStackNode;
  private constructor(id: string) { this.n = { type: "stack", id, children: [] }; }
  static of(id: string, ...children: Renderable[]): UiStack {
    const s = new UiStack(id);
    children.forEach((c) => s.child(c));
    return s;
  }
  child(c: Renderable): UiStack { this.n.children.push(node(c)); return this; }
  direction(d: "VERTICAL" | "HORIZONTAL"): UiStack { this.n.direction = d; return this; }
  gap(px: number): UiStack { this.n.gap = px; return this; }
  withCssClass(c: string): UiStack { this.n.cssClass = c; return this; }
  render(): UiStackNode { return this.n; }
}

// ── List + item ──────────────────────────────────────────────────────────────

export class UiList {
  private n: UiListNode & { actions?: UiActionNode[]; headerExtra?: UiNode };
  private constructor(id: string, title?: string | null) {
    this.n = { type: "list", id, items: [] };
    if (title) this.n.title = title;
  }
  static of(id: string, title?: string | null): UiList { return new UiList(id, title); }
  icon(name: string): UiList { this.n.icon = name; return this; }
  withCssClass(c: string): UiList { this.n.cssClass = c; return this; }
  action(a: UiAction): UiList { (this.n.actions ??= []).push(a.render()); return this; }
  headerExtra(x: Renderable): UiList { this.n.headerExtra = node(x); return this; }
  item(it: UiItem | UiListItem): UiList {
    this.n.items.push((it as UiItem).render ? (it as UiItem).render() : (it as UiListItem));
    return this;
  }
  getItems(): UiListItem[] { return this.n.items; }
  render(): UiListNode { return this.n; }
}

export class UiItem {
  private n: UiListItem & { description?: string; collapseSummary?: string; collapseOpen?: boolean;
    collapseSummaryId?: string; collapseClientControlled?: boolean; };
  private constructor(id: string, label: string) { this.n = { id, label } as any; }
  static of(id: string, label: string): UiItem { return new UiItem(id, label); }
  content(c: Renderable): UiItem { this.n.content = node(c); return this; }
  description(d: string): UiItem { this.n.description = d; return this; }
  icon(name: string): UiItem { this.n.icon = name; return this; }
  withCssClass(c: string): UiItem { (this.n as { cssClass?: string }).cssClass = c; return this; }
  action(a: UiAction): UiItem { (this.n.actions ??= []).push(a.render()); return this; }
  collapsible(summary: string, open: boolean): UiItem {
    this.n.collapseSummary = summary; this.n.collapseOpen = open; return this;
  }
  collapsibleClient(summary: string, summaryId?: string | null): UiItem {
    this.n.collapseSummary = summary;
    this.n.collapseClientControlled = true;
    if (summaryId) this.n.collapseSummaryId = summaryId;
    return this;
  }
  selected(sel: boolean): UiItem {
    if (sel) { const n = this.n as { cssClass?: string }; n.cssClass = ((n.cssClass ?? "") + " selected").trim(); }
    return this;
  }
  onClick(t: UiTrigger): UiItem { this.n.onClick = t; return this; }
  invoke(handler: string, url?: string): UiItem { this.n.onClick = UiTriggerB.invoke(handler, url); return this; }
  render(): UiListItem { return this.n; }
}

// ── Form + field ─────────────────────────────────────────────────────────────

export class UiForm {
  private n: UiFormNode;
  private constructor(id: string, title?: string | null) {
    this.n = { type: "form", id, fields: [] };
    if (title) this.n.title = title;
  }
  static of(id: string, title?: string | null): UiForm { return new UiForm(id, title); }
  field(f: UiField): UiForm { this.n.fields.push(f.render()); return this; }
  action(a: UiAction): UiForm { (this.n.actions ??= []).push(a.render()); return this; }
  withCssClass(c: string): UiForm { this.n.cssClass = c; return this; }
  render(): UiFormNode { return this.n; }
}

export class UiField {
  private n: UiFieldNode;
  private constructor(id: string, label: string, fieldType: UiFieldNode["fieldType"], value: unknown) {
    this.n = { type: "field", id, label, fieldType, value };
  }
  static textarea(id: string, label: string, value: string | null): UiField {
    return new UiField(id, label, "TEXTAREA", value ?? "");
  }
  static text(id: string, label: string, value: string | null): UiField {
    return new UiField(id, label, "TEXT", value ?? "");
  }
  static select(id: string, label: string, value: string, options: Array<{ value: string; label: string }>): UiField {
    const f = new UiField(id, label, "SELECT", value);
    f.n.options = options;
    return f;
  }
  onChangeInvoke(handler: string, formId: string): UiField {
    this.n.onChange = UiTriggerB.invoke(handler, undefined, formId); return this;
  }
  asEditable(): UiField { this.n.editable = true; return this; }
  asRequired(): UiField { this.n.required = true; return this; }
  placeholder(p: string): UiField { this.n.placeholder = p; return this; }
  submitOnEnter(): UiField { this.n.submitOnEnter = true; return this; }
  render(): UiFieldNode { return this.n; }
}

// ── Link ─────────────────────────────────────────────────────────────────────

export class UiLink {
  private n: UiLinkNode;
  private constructor(id: string, href: string, label: string) {
    this.n = { type: "link", id, href, label } as UiLinkNode;
  }
  static external(id: string, href: string, label: string): UiLink { return new UiLink(id, href, label); }
  render(): UiLinkNode { return this.n; }
}

// ── Menu (history drawer) ────────────────────────────────────────────────────

export class UiMenu {
  private n: UiMenuNode;
  private constructor(id: string, title?: string) { this.n = { type: "menu", id, items: [] }; if (title) this.n.title = title; }
  static of(id: string, title?: string): UiMenu { return new UiMenu(id, title); }
  side(s: "LEFT" | "RIGHT"): UiMenu { this.n.side = s; return this; }
  mode(m: "PUSH" | "OVERLAY" | "RESPONSIVE"): UiMenu { this.n.mode = m; return this; }
  state(s: "EXPANDED" | "RAIL" | "HIDDEN"): UiMenu { this.n.state = s; return this; }
  toggle(t: boolean): UiMenu { this.n.toggle = t; return this; }
  item(it: UiMenuItem): UiMenu { this.n.items.push(it.render()); return this; }
  render(): UiMenuNode { return this.n; }
}

export class UiMenuItem {
  private n: UiMenuItemNode;
  private constructor(id: string, label?: string) { this.n = { type: "menu-item", id, label }; }
  static of(id: string, label: string): UiMenuItem { return new UiMenuItem(id, label); }
  static link(id: string, label: string, href: string): UiMenuItem {
    const m = new UiMenuItem(id, label); m.n.href = href; return m;
  }
  static divider(): UiMenuItem { const m = new UiMenuItem("divider-" + Math.random().toString(36).slice(2)); (m.n as any).divider = true; return m; }
  icon(name: string): UiMenuItem { this.n.icon = name; return this; }
  badge(text: string): UiMenuItem { this.n.badge = text; return this; }
  selected(sel: boolean): UiMenuItem { this.n.selected = sel; return this; }
  onClick(t: UiTrigger): UiMenuItem { this.n.onClick = t; return this; }
  invoke(handler: string, url?: string): UiMenuItem { this.n.onClick = UiTriggerB.invoke(handler, url); return this; }
  render(): UiMenuItemNode { return this.n; }
}

// ── App shell ────────────────────────────────────────────────────────────────

export class UiAppShell {
  private n: UiAppShellNode;
  private constructor(id: string) { this.n = { type: "app-shell", id } as UiAppShellNode; }
  static of(id: string): UiAppShell { return new UiAppShell(id); }
  menu(m: UiMenu): UiAppShell { (this.n as any).menu = m.render(); return this; }
  content(c: Renderable): UiAppShell { (this.n as any).content = node(c); return this; }
  // The app-shell node is not part of the UiNode content union, but the
  // renderer renders it as a root; callers mount it as a node.
  render(): UiNode { return this.n as unknown as UiNode; }
}

// ── Patch operations ─────────────────────────────────────────────────────────

export const Op = {
  append: (targetId: string, n: Renderable): UiPatchOperation => ({ op: "APPEND", targetId, node: node(n) }),
  replace: (targetId: string, n: Renderable): UiPatchOperation => ({ op: "REPLACE", targetId, node: node(n) }),
  remove: (targetId: string): UiPatchOperation => ({ op: "REMOVE", targetId }),
};
