// The phone's end of the WS tunnel: one WebSocket to the relay, many
// multiplexed HTTP requests over it. Mirrors the JavaFX ApiClient's
// endpoints, but every call travels as {reqId, method, path, body} frames.
// The Firebase sibling with the same interface is rtdb-client.js.
import { TunnelClient } from './client-common.js';

export class RelayClient extends TunnelClient {
  /**
   * @param relayUrl    http(s) origin of the relay, e.g. https://relay.example.run
   * @param deviceToken signed token from pairing
   */
  constructor(relayUrl, deviceToken) {
    super();
    this.relayUrl = relayUrl.replace(/\/$/, '');
    this.deviceToken = deviceToken;
    this.pending = new Map(); // reqId → {resolve, reject, onChunk, status, parts}
    this.nextId = 1;
    this.ws = null;
    this.closed = false;
    this.backoffMs = 1000;
  }

  connect() {
    if (this.closed) return;
    this.onstate('connecting');
    const wsUrl = this.relayUrl.replace(/^http/, 'ws')
        + '/ws/device?token=' + encodeURIComponent(this.deviceToken);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onmessage = (msg) => {
      let frame;
      try {
        frame = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (frame.type === 'connected') {
        this.backoffMs = 1000;
        this.onstate(frame.serverOnline ? 'online' : 'server_offline');
        this._readyResolve();
        return;
      }
      if (frame.type === 'server_offline') {
        this.onstate('server_offline');
        return;
      }
      const req = this.pending.get(frame.reqId);
      if (!req) return;
      if (frame.status) req.status = frame.status;
      if (frame.chunk != null) {
        req.parts.push(frame.chunk);
        req.onChunk?.(frame.chunk);
      }
      if (frame.done) {
        this.pending.delete(frame.reqId);
        req.resolve({ status: req.status ?? 0, text: req.parts.join('') });
      } else if (frame.error) {
        this.pending.delete(frame.reqId);
        req.reject(new Error(frame.error));
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      for (const req of this.pending.values()) req.reject(new Error('relay connection lost'));
      this.pending.clear();
      this.onstate('offline');
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    };
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  /**
   * One tunneled HTTP request. Resolves with {status, text} when the
   * connector reports done; onChunk sees the body as it streams (SSE).
   * An AbortSignal sends a cancel frame so long-lived streams can be
   * superseded cleanly.
   */
  request(method, path, { body = null, bodyBase64 = null, contentType = null,
      onChunk = null, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected to the relay'));
        return;
      }
      const reqId = 'r-' + this.nextId++;
      this.pending.set(reqId, { resolve, reject, onChunk, parts: [] });
      signal?.addEventListener('abort', () => {
        if (this.pending.delete(reqId)) {
          this.ws?.readyState === WebSocket.OPEN
              && this.ws.send(JSON.stringify({ reqId, cancel: true }));
          reject(new DOMException('aborted', 'AbortError'));
        }
      });
      const frame = { reqId, method, path, body };
      if (bodyBase64 != null) { frame.bodyBase64 = bodyBase64; frame.contentType = contentType; }
      this.ws.send(JSON.stringify(frame));
    });
  }
}

/** Redeems a pairing code — the one call that goes to the relay directly. */
export async function pair(relayUrl, code) {
  const res = await fetch(relayUrl.replace(/\/$/, '') + '/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.trim().toUpperCase() }),
  });
  if (!res.ok) {
    throw new Error((await res.json().catch(() => null))?.error ?? `pairing failed (${res.status})`);
  }
  return res.json(); // {deviceToken, serverId}
}
