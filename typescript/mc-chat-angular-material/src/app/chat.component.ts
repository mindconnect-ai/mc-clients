import { ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, OnChanges, Output, ViewChild } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatSnackBar } from "@angular/material/snack-bar";
import { ApiService } from "./api.service";
import { MarkdownPipe } from "./markdown.pipe";
import type { Agent, ChatItem, Frame, Session } from "./models";

let counter = 0;
const uid = (p: string) => `${p}-${++counter}`;
const pretty = (x: unknown) => { try { return JSON.stringify(x, null, 2); } catch { return String(x); } };

/**
 * The conversation and composer. Loads history, renders the chat log (message
 * bubbles, tool cards, approval cards) and drives a turn: send the message,
 * consume the SSE stream, and translate each frame into the item list — the
 * Angular twin of the server's runTurnStream render loop.
 */
@Component({
  selector: "mc-chat",
  standalone: true,
  imports: [
    CommonModule, FormsModule, MarkdownPipe,
    MatButtonModule, MatCardModule, MatFormFieldModule, MatIconModule, MatInputModule,
  ],
  template: `
    <div class="chat-log" #log>
      <ng-container *ngFor="let item of items; trackBy: trackId">
        <div *ngIf="item.kind === 'message'"
             class="bubble" [class.user]="item.role === 'user'" [class.bot]="item.role === 'bot'"
             [class.streaming]="item.streaming">
          <div class="speaker">{{ item.role === 'user' ? 'You' : agent.name }}</div>
          <div [innerHTML]="item.text | markdown"></div>
        </div>

        <mat-card *ngIf="item.kind === 'tool'" class="tool-card" appearance="outlined">
          <mat-card-header>
            <mat-card-title>{{ stateIcon(item.state) }} {{ item.name }}
              <span *ngIf="item.durationMs"> · {{ item.durationMs | number:'1.0-0' }} ms</span>
            </mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <pre>{{ item.inputJson }}</pre>
            <pre *ngIf="item.output">{{ item.output }}</pre>
          </mat-card-content>
        </mat-card>

        <mat-card *ngIf="item.kind === 'approval'" class="approval-card" appearance="outlined">
          <mat-card-header><mat-card-title>Approval required</mat-card-title></mat-card-header>
          <mat-card-content>
            <p>The agent wants to run <strong><code>{{ item.toolName }}</code></strong>.</p>
            <pre>{{ item.argsJson }}</pre>
          </mat-card-content>
          <mat-card-actions class="approval-actions">
            <button mat-button color="warn" (click)="answer(item, false, 'once')">Deny</button>
            <button mat-stroked-button (click)="answer(item, true, 'once')">Allow once</button>
            <button mat-flat-button color="primary" (click)="answer(item, true, 'session')">Allow for session</button>
          </mat-card-actions>
        </mat-card>
      </ng-container>
    </div>

    <div class="composer">
      <button mat-icon-button (click)="fileInput.click()" [disabled]="streaming" aria-label="Attach file">
        <mat-icon>attach_file</mat-icon>
      </button>
      <input #fileInput type="file" hidden (change)="onFile(fileInput)">
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <textarea matInput [(ngModel)]="draft" [disabled]="streaming" rows="1"
                  placeholder="Ask anything …" (keydown)="onKey($event)"></textarea>
      </mat-form-field>
      <button *ngIf="!streaming" mat-flat-button color="primary" (click)="send()">Send</button>
      <button *ngIf="streaming" mat-flat-button color="warn" (click)="stop()">Stop</button>
    </div>
  `,
})
export class ChatComponent implements OnChanges {
  @Input({ required: true }) agent!: Agent;
  /** The open conversation, or undefined for a fresh window — created on first send. */
  @Input() session?: Session;
  @Output() sessionCreated = new EventEmitter<Session>();
  @ViewChild("log") private log?: ElementRef<HTMLElement>;

  items: ChatItem[] = [];
  draft = "";
  streaming = false;

  private cumulative = "";
  private pending?: Extract<ChatItem, { kind: "message" }>;
  private liveTasks = new Map<string, Extract<ChatItem, { kind: "tool" }>>();

  constructor(private readonly api: ApiService, private readonly snack: MatSnackBar,
              private readonly cdr: ChangeDetectorRef) {}

  async ngOnChanges(): Promise<void> {
    this.items = [];
    this.streaming = false;
    if (!this.session) { this.cdr.detectChanges(); return; }
    const [history, approvals] = await Promise.all([
      this.api.history(this.session.id), this.api.openApprovals(this.session.id),
    ]);
    for (const m of history) {
      if (m.type === "CHAT") {
        this.items.push({ kind: "message", id: uid("m"), role: m.senderType === "USER" ? "user" : "bot", text: m.content ?? "" });
      } else if (m.type === "TOOL_CALL") {
        const names = this.toolNames(m.content);
        if (names) this.items.push({ kind: "tool", id: uid("t"), name: names, state: "done", inputJson: "" });
      }
    }
    for (const a of approvals) {
      const call = this.parse(a.content);
      this.items.push({ kind: "approval", id: uid("a"), callId: a.callId, toolName: a.toolName ?? call.name, argsJson: call.argsJson });
    }
    this.cdr.detectChanges();
  }

  trackId = (_: number, item: ChatItem) => item.id;
  stateIcon = (s: string) => (s === "failed" ? "✗" : s === "done" ? "✓" : "⏳");

  onKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
  }

  async send(): Promise<void> {
    const message = this.draft.trim();
    if (!message || this.streaming) return;
    if (!this.session) {
      this.session = await this.api.createSession(this.agent.id);
      this.sessionCreated.emit(this.session);
    }
    this.draft = "";
    this.items.push({ kind: "message", id: uid("m"), role: "user", text: message });
    this.streaming = true;
    this.cumulative = "";
    this.pending = undefined;
    this.liveTasks.clear();
    this.scroll();
    try {
      await this.api.chat(this.session.id, message, (f) => this.onFrame(f));
    } catch (e) {
      this.items.push({ kind: "message", id: uid("m"), role: "bot", text: "⚠️ **The turn failed:** " + (e as Error).message });
    } finally {
      this.streaming = false;
      this.cdr.detectChanges();
    }
  }

  private onFrame(f: Frame, indent = false): void {
    if (f.type === "sub_agent_event" && f.inner) { this.onFrame(f.inner, true); return; }
    switch (f.type) {
      case "token":
        if (indent) break;
        this.cumulative += f.text ?? "";
        if (!this.pending) {
          this.pending = { kind: "message", id: uid("m"), role: "bot", text: "", streaming: true };
          this.items.push(this.pending);
        }
        this.pending.text = this.cumulative;
        break;
      case "tool_call_started": {
        const item: Extract<ChatItem, { kind: "tool" }> =
          { kind: "tool", id: uid("t"), name: f.toolName ?? "?", state: "running", inputJson: pretty(f.arguments) };
        this.liveTasks.set("tool:" + (f.toolName ?? ""), item);
        this.items.push(item);
        break;
      }
      case "tool_call_result":
      case "tool_call_failed": {
        const item = this.liveTasks.get("tool:" + (f.toolName ?? ""));
        if (item) {
          item.state = f.type === "tool_call_failed" ? "failed" : "done";
          item.output = f.type === "tool_call_failed" ? f.error : f.result;
          item.durationMs = f.durationMs;
          this.liveTasks.delete("tool:" + (f.toolName ?? ""));
        }
        break;
      }
      case "sub_agent_started": {
        const item: Extract<ChatItem, { kind: "tool" }> =
          { kind: "tool", id: uid("t"), name: "↳ " + (f.agentName ?? "Sub-Agent"), state: "running", inputJson: pretty(f.text) };
        this.liveTasks.set("sub:" + (f.agentName ?? ""), item);
        this.items.push(item);
        break;
      }
      case "sub_agent_done":
      case "sub_agent_error": {
        const item = this.liveTasks.get("sub:" + (f.agentName ?? ""));
        if (item) {
          item.state = f.type === "sub_agent_error" ? "failed" : "done";
          item.output = f.type === "sub_agent_error" ? f.error : f.finalText;
          this.liveTasks.delete("sub:" + (f.agentName ?? ""));
        }
        break;
      }
      case "approval_requested":
        this.items.push({ kind: "approval", id: uid("a"), callId: f.text!, toolName: f.toolName ?? "?",
          argsJson: f.arguments ? pretty(f.arguments) : "{}" });
        break;
      case "done":
        if (this.pending) this.pending.streaming = false;
        break;
      case "error":
        this.items.push({ kind: "message", id: uid("m"), role: "bot", text: "⚠️ " + (f.error ?? f.text ?? "Error") });
        break;
    }
    this.cdr.detectChanges();
    this.scroll();
  }

  async answer(item: Extract<ChatItem, { kind: "approval" }>, approved: boolean, scope: string): Promise<void> {
    if (!this.session) return;
    try {
      await this.api.answerApproval(this.session.id, item.callId, approved, scope);
      this.items = this.items.filter((i) => i !== item);
    } catch (e) {
      this.snack.open((e as Error).message, "OK", { duration: 4000 });
    }
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    await this.api.cancel(this.session.id);
    this.streaming = false;
  }

  async onFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = "";
    if (!file || !this.session) return;
    const res = await this.api.uploadFile(this.session.id, file);
    this.snack.open(res.ok ? `Uploaded ${file.name}` : `Upload failed (${res.status})`, "OK", { duration: 3000 });
  }

  private scroll(): void {
    queueMicrotask(() => { const el = this.log?.nativeElement; if (el) el.scrollTop = el.scrollHeight; });
  }

  private parse(content?: string): { name: string; argsJson: string } {
    try {
      const n = JSON.parse(content ?? "{}");
      return { name: n?.name ?? "?", argsJson: n?.arguments ? pretty(n.arguments) : "{}" };
    } catch { return { name: "?", argsJson: "{}" }; }
  }

  private toolNames(content?: string): string | null {
    try {
      const names = (JSON.parse(content ?? "{}").toolCalls ?? []).map((c: any) => c.name);
      return names.length ? "⚙ " + names.join(", ") : null;
    } catch { return null; }
  }
}
