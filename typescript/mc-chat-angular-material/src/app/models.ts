// Domain + view models shared across the Angular chat client.

export interface Agent { id: string; name: string; description?: string; status?: string; }
export interface Session { id: string; title?: string | null; startedAt?: string; status?: string; }
export interface HistoryMessage { type: string; senderType?: string; content?: string; }
export interface Approval { callId: string; toolName?: string; content?: string; }

/** One SSE StreamEventFrame — only the fields the chat reads. */
export interface Frame {
  type: string;
  text?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  finalText?: string;
  error?: string;
  agentName?: string;
  taskId?: string;
  inner?: Frame;
}

/** A rendered conversation entry — the *ngFor union the chat log iterates. */
export type ChatItem =
  | { kind: "message"; id: string; role: "user" | "bot"; text: string; streaming?: boolean }
  | { kind: "tool"; id: string; name: string; state: "running" | "done" | "failed"; inputJson: string; output?: string; durationMs?: number }
  | { kind: "approval"; id: string; callId: string; toolName: string; argsJson: string };
