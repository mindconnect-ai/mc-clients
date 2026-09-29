/**
 * The slice of the agent server's REST API (/api/**) the extension needs —
 * the same surface the TypeScript chat clients use. Auth is off on a local
 * server (every request runs as the dev user), so there is no token here yet.
 */

export interface Agent {
  id: string;
  name: string;
  description: string;
}

/** One tool on an agent, as the server reads and writes it; bound by name, the id is per agent. */
export interface AgentToolBinding {
  id?: string;
  name: string;
  description?: string;
  overrides?: Record<string, unknown>;
  enabled?: boolean;
  deferred?: boolean;
  needsApproval?: boolean;
  maxResultChars?: number | null;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  tools?: AgentToolBinding[];
}

export interface Session {
  id: string;
  workingDir?: string | null;
}

/** One SSE StreamEventFrame — only the fields the extension reads. */
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

export type ApprovalScope = "once" | "session";

export class MindconnectClient {
  constructor(private readonly baseUrl: () => string) {}

  /** True when the server answers the agent list — the readiness probe. */
  async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(this.url("/api/agents"), { headers: { accept: "application/json" }, signal });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** The agent a setting names — by name (as the seed data has them, e.g. coding-assistant) or by id. */
  async findAgent(nameOrId: string): Promise<Agent> {
    const agents = await this.listAgents();
    const agent = agents.find((a) => a.id === nameOrId) ?? agents.find((a) => a.name === nameOrId);
    if (!agent) throw new Error(`No active agent “${nameOrId}” on the server — pick one with “MindConnect: Select Agent”.`);
    return agent;
  }

  async listAgents(): Promise<Agent[]> {
    const agents = await this.json<any[]>("/api/agents");
    return agents
      .filter((a) => (a.status ?? "ACTIVE") === "ACTIVE")
      .map((a) => ({ id: a.id, name: a.name ?? a.id, description: a.description ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The agent as stored — tools, system prompt and all. */
  agentDefinition(agentId: string): Promise<AgentDefinition> {
    return this.json<AgentDefinition>(`/api/agents/${encodeURIComponent(agentId)}`);
  }

  /** A copy named “{name}-copy”, without tools. */
  copyAgent(agentId: string): Promise<AgentDefinition> {
    return this.json<AgentDefinition>(`/api/agents/${encodeURIComponent(agentId)}/copy`, { method: "POST" });
  }

  /** Partial update — absent fields keep their value. */
  updateAgent(agentId: string, patch: { name?: string; description?: string; systemPrompt?: string }): Promise<AgentDefinition> {
    return this.json<AgentDefinition>(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  /** Replaces the agent's whole tool list. */
  updateTools(agentId: string, tools: AgentToolBinding[]): Promise<AgentDefinition> {
    return this.json<AgentDefinition>(`/api/agents/${encodeURIComponent(agentId)}/tools`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools }),
    });
  }

  /** A session working in {@code workingDir} — the file tools' base, named in the prompt. */
  createSession(agentId: string, workingDir?: string, additionalDirs: string[] = []): Promise<Session> {
    return this.json<Session>("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, workingDir, additionalDirs }),
    });
  }

  /** Moves a session to another folder; takes effect from the next turn on. */
  async changeWorkingDir(sessionId: string, workingDir: string, additionalDirs: string[] = []): Promise<void> {
    await this.json(`/api/sessions/${encodeURIComponent(sessionId)}/working-dir`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workingDir, additionalDirs }),
    });
  }

  async answerApproval(sessionId: string, callId: string, approved: boolean, scope: ApprovalScope): Promise<void> {
    const res = await fetch(
      this.url(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(callId)}`
        + `?approved=${approved}&scope=${scope}`),
      { method: "POST" },
    );
    if (res.status === 404) throw new Error("This request is no longer open.");
    if (!res.ok) throw new Error(`approval: HTTP ${res.status}`);
  }

  async cancel(sessionId: string): Promise<void> {
    await fetch(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/chat`), { method: "DELETE" });
  }

  /**
   * Sends the message and streams the turn's frames until the turn ends — a
   * done or error frame; the server does not always close the stream after an
   * error. fetch + a reader rather than EventSource: the endpoint takes a POST
   * body, which EventSource cannot send.
   */
  async chat(sessionId: string, message: string, onFrame: (f: Frame) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/chat`), {
      method: "POST",
      headers: { "content-type": "text/plain", accept: "text/event-stream" },
      body: message,
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`chat: HTTP ${res.status}`);
    await readSse(res.body, onFrame);
  }

  private url(path: string): string {
    return this.baseUrl().replace(/\/+$/, "") + path;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), { ...init, headers: { accept: "application/json", ...init?.headers } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${init?.method ?? "GET"} ${path}: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** Parses an SSE body into JSON frames — one event per blank-line-separated block. */
const TERMINAL_FRAMES = new Set(["done", "error"]);

async function readSse(body: ReadableStream<Uint8Array>, onFrame: (f: Frame) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  const flush = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let frame: Frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return; // not a JSON frame (keep-alive comment or similar) — nothing to show
    }
    onFrame(frame);
    if (TERMINAL_FRAMES.has(frame.type)) ended = true;
  };
  while (!ended) {
    const { value, done } = await reader.read();
    if (done) {
      flush(buffer);
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let end: RegExpExecArray | null;
    while (!ended && (end = /\r?\n\r?\n/.exec(buffer))) {
      flush(buffer.slice(0, end.index));
      buffer = buffer.slice(end.index + end[0].length);
    }
  }
  await reader.cancel().catch(() => undefined);
}
