// The slice of the agent server's REST API (/api/**) a chat needs. Same
// endpoints and SSE frames the JavaFX ApiClient and the server-side chat UI
// use — see StreamEventFrame / SessionStreamFrame on the server. All calls go
// to the same origin; in dev Vite proxies /api to the agent server.

export const NAMESPACE = "local";
export const USER_ID = "mc_user";

export interface Agent { id: string; name: string; description?: string; status?: string; }
export interface Session { id: string; title?: string | null; startedAt?: string; status?: string; }
export interface HistoryMessage { type: string; senderType?: string; content?: string; }
export interface Approval { callId: string; toolName?: string; content?: string; }

/** One SSE event of a turn — the flat StreamEventFrame, only the fields a
 *  chat reads. approval_requested overloads `text` with the callId. */
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

export interface Attached { firstBufferedSeq: number; latestSeq: number; liveTurnId: string | null; }
export interface StreamFrame { seq: number; turnId: string; run: number; event: Frame; }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" }, credentials: "include" });
  if (!res.ok) throw new Error(`${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

export async function listAgents(): Promise<Agent[]> {
  const agents = await getJson<any[]>(`/api/agents?namespace=${NAMESPACE}`);
  return agents
    .filter((a) => (a.status ?? "ACTIVE") === "ACTIVE")
    .map((a) => ({ id: a.id, name: a.name, description: a.description ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSessions(agentId: string): Promise<Session[]> {
  const sessions = await getJson<any[]>(
    `/api/sessions?agentId=${agentId}&namespace=${NAMESPACE}&userId=${encodeURIComponent(USER_ID)}`,
  );
  return sessions
    .filter((s) => (s.status ?? "ACTIVE") === "ACTIVE")
    .map((s) => ({ id: s.id, title: s.title ?? null, startedAt: s.startedAt ?? "" }))
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

export async function createSession(agentId: string): Promise<Session> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ agentId, namespace: NAMESPACE, userId: USER_ID }),
  });
  if (!res.ok) throw new Error(`create session: ${res.status}`);
  return res.json();
}

export async function history(sessionId: string): Promise<HistoryMessage[]> {
  return getJson<HistoryMessage[]>(`/api/sessions/${sessionId}/history`);
}

export async function openApprovals(sessionId: string): Promise<Approval[]> {
  return getJson<Approval[]>(`/api/sessions/${sessionId}/approvals`);
}

export async function answerApproval(
  sessionId: string, callId: string, approved: boolean, scope: string,
): Promise<void> {
  const res = await fetch(
    `/api/sessions/${sessionId}/approvals/${encodeURIComponent(callId)}?approved=${approved}&scope=${scope}`,
    { method: "POST", credentials: "include" },
  );
  if (res.status === 404) throw new Error("This request is no longer open.");
  if (!res.ok) throw new Error(`approval: ${res.status}`);
}

export async function uploadFile(sessionId: string, file: File): Promise<Response> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  return fetch(`/api/sessions/${sessionId}/files`, { method: "POST", body: fd, credentials: "include" });
}

/** Parse an SSE byte stream, delivering each `data:` frame's JSON. */
async function readSse(body: ReadableStream<Uint8Array>, onData: (json: any) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) {
        try { onData(JSON.parse(line.slice(5).trim())); } catch { /* half a frame */ }
      }
    }
  }
}

/** Sends the message (raw text body) and streams the turn's frames. */
export async function chat(sessionId: string, message: string, onFrame: (f: Frame) => void): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "content-type": "text/plain", accept: "text/event-stream" },
    credentials: "include",
    body: message,
  });
  if (!res.ok || !res.body) throw new Error(`chat: ${res.status}`);
  await readSse(res.body, onFrame);
}

/** Attaches to the session stream after `afterSeq`, delivering the opening
 *  Attached frame then every event. Resolves when the emitter closes. */
export async function attach(
  sessionId: string, afterSeq: number,
  onAttached: (a: Attached) => void, onFrame: (f: StreamFrame) => void, signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/stream?afterSeq=${afterSeq}`, {
    headers: { accept: "text/event-stream" }, credentials: "include", signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream: ${res.status}`);
  await readSse(res.body, (json) => {
    if (json.type === "attached") onAttached(json as Attached);
    else onFrame(json as StreamFrame);
  });
}
