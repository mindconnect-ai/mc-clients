import { Injectable } from "@angular/core";
import type { Agent, Approval, Frame, HistoryMessage, Session } from "./models";

const NAMESPACE = "local";
const USER_ID = "mc_user";

/**
 * The slice of the agent server's REST API (/api/**) the chat needs. SSE is
 * consumed with fetch + a ReadableStream reader rather than HttpClient/
 * EventSource: the chat endpoint takes a text/plain body and streams
 * text/event-stream back, which EventSource (GET-only) can't do.
 */
@Injectable({ providedIn: "root" })
export class ApiService {
  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(path, { headers: { accept: "application/json" }, credentials: "include" });
    if (!res.ok) throw new Error(`${res.status} for ${path}`);
    return res.json() as Promise<T>;
  }

  async listAgents(): Promise<Agent[]> {
    const agents = await this.getJson<any[]>(`/api/agents?namespace=${NAMESPACE}`);
    return agents
      .filter((a) => (a.status ?? "ACTIVE") === "ACTIVE")
      .map((a) => ({ id: a.id, name: a.name, description: a.description ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listSessions(agentId: string): Promise<Session[]> {
    const sessions = await this.getJson<any[]>(
      `/api/sessions?agentId=${agentId}&namespace=${NAMESPACE}&userId=${encodeURIComponent(USER_ID)}`,
    );
    return sessions
      .filter((s) => (s.status ?? "ACTIVE") === "ACTIVE")
      .map((s) => ({ id: s.id, title: s.title ?? null, startedAt: s.startedAt ?? "" }))
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  }

  async createSession(agentId: string): Promise<Session> {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ agentId, namespace: NAMESPACE, userId: USER_ID }),
    });
    if (!res.ok) throw new Error(`create session: ${res.status}`);
    return res.json();
  }

  history(sessionId: string): Promise<HistoryMessage[]> {
    return this.getJson<HistoryMessage[]>(`/api/sessions/${sessionId}/history`);
  }

  openApprovals(sessionId: string): Promise<Approval[]> {
    return this.getJson<Approval[]>(`/api/sessions/${sessionId}/approvals`);
  }

  async answerApproval(sessionId: string, callId: string, approved: boolean, scope: string): Promise<void> {
    const res = await fetch(
      `/api/sessions/${sessionId}/approvals/${encodeURIComponent(callId)}?approved=${approved}&scope=${scope}`,
      { method: "POST", credentials: "include" },
    );
    if (res.status === 404) throw new Error("This request is no longer open.");
    if (!res.ok) throw new Error(`approval: ${res.status}`);
  }

  uploadFile(sessionId: string, file: File): Promise<Response> {
    const fd = new FormData();
    fd.append("file", file, file.name);
    return fetch(`/api/sessions/${sessionId}/files`, { method: "POST", body: fd, credentials: "include" });
  }

  async cancel(sessionId: string): Promise<void> {
    await fetch(`/api/sessions/${sessionId}/chat`, { method: "DELETE", credentials: "include" });
  }

  /** Sends the message (raw text) and streams the turn's frames. */
  async chat(sessionId: string, message: string, onFrame: (f: Frame) => void): Promise<void> {
    const res = await fetch(`/api/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "text/plain", accept: "text/event-stream" },
      credentials: "include",
      body: message,
    });
    if (!res.ok || !res.body) throw new Error(`chat: ${res.status}`);
    await this.readSse(res.body, onFrame);
  }

  private async readSse(body: ReadableStream<Uint8Array>, onFrame: (f: Frame) => void): Promise<void> {
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
          try { onFrame(JSON.parse(line.slice(5).trim())); } catch { /* half a frame */ }
        }
      }
    }
  }
}
