// What the app sees of a tunnel, whatever the wire underneath: the WS
// relay (relay-client.js) and the Firebase RTDB variant (rtdb-client.js)
// both extend this. Subclasses provide connect()/close(), a `ready`
// promise, an onstate callback, and
//   request(method, path, {body, onChunk, signal}) → Promise<{status, text}>
export class TunnelClient {
  constructor() {
    this.onstate = () => {}; // 'connecting' | 'online' | 'server_offline' | 'offline'
    this.ready = new Promise((resolve) => { this._readyResolve = resolve; });
  }

  /** GET expecting JSON. Throws on non-2xx. */
  async getJson(path) {
    const { status, text } = await this.request('GET', path);
    if (Math.floor(status / 100) !== 2) throw new Error(`server answered ${status} for ${path}`);
    return JSON.parse(text);
  }

  async postJson(path, bodyObj = null) {
    const { status, text } = await this.request('POST', path,
        { body: bodyObj == null ? null : JSON.stringify(bodyObj) });
    if (Math.floor(status / 100) !== 2) throw new Error(`server answered ${status} for ${path}`);
    return text ? JSON.parse(text) : null;
  }

  /**
   * A tunneled SSE stream: parses `data:` lines out of the chunk flow and
   * hands each JSON event to onEvent. Resolves when the stream ends
   * (the server's emitters time out after ~120 s — callers loop).
   */
  sse(method, path, { body = null, onEvent, signal = null }) {
    let buffer = '';
    return this.request(method, path, {
      body,
      signal,
      onChunk: (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith('data:')) {
            try {
              onEvent(JSON.parse(line.slice(5)));
            } catch {
              // half a frame or junk — skip the line, keep the stream
            }
          }
        }
      },
    });
  }
}
