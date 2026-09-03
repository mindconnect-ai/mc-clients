// The transport-independent half of the connector: replay one tunneled
// HTTP frame against the local API (or the connector's own /relay/**
// control surface) and report the answer through a sink. Both transports
// — the WS relay and the Firebase RTDB variant — feed frames in here.

/**
 * @param apiBase e.g. http://localhost:8080
 * @param serverId this home server's name
 * @param push    the PushWatcher handling /relay/push/** routes
 * @return execute({method, path, body}, sink, signal) — sink is
 *         { status(code, headers), chunk(text), done(), error(message) };
 *         status/chunk/done never follow error, done is always last.
 */
export function createProxy({ apiBase, serverId, push }) {
  async function execute({ method, path, body, bodyBase64, contentType }, sink, signal) {
    if (path.startsWith('/relay/')) {
      handleLocal(method, path, body, sink);
      return;
    }
    // Everything else must be the API — the tunnel is not a generic
    // proxy into the home network.
    if (!path.startsWith('/api/')) {
      sink.error('only /api/** and /relay/** are tunneled');
      return;
    }
    // A bodyBase64 carries raw bytes (a file upload's multipart payload) with
    // an explicit contentType, so binary rides the text-only tunnel intact.
    const accept = 'text/event-stream, application/json';
    let reqBody;
    let headers;
    if (bodyBase64 != null) {
      reqBody = Buffer.from(bodyBase64, 'base64');
      headers = { 'content-type': contentType || 'application/octet-stream', accept };
    } else if (body != null) {
      reqBody = body;
      headers = { 'content-type': 'application/json', accept };
    } else {
      reqBody = undefined;
      headers = { accept };
    }
    try {
      const res = await fetch(apiBase + path, { method, headers, body: reqBody, signal });
      sink.status(res.status, { 'content-type': res.headers.get('content-type') ?? 'application/json' });
      if (res.body) {
        for await (const chunk of res.body) {
          sink.chunk(Buffer.from(chunk).toString('utf8'));
        }
      }
      sink.done();
    } catch (e) {
      if (!signal?.aborted) sink.error(e.message);
    }
  }

  /** POST /relay/push/watch {sessionId, fcmToken} · POST /relay/push/token {fcmToken} · GET /relay/ping */
  function handleLocal(method, path, body, sink) {
    const reply = (status, obj) => {
      sink.status(status, { 'content-type': 'application/json' });
      sink.chunk(JSON.stringify(obj));
      sink.done();
    };
    try {
      const route = path.split('?')[0];
      const payload = body ? JSON.parse(body) : {};
      if (method === 'GET' && route === '/relay/ping') {
        reply(200, { ok: true, serverId, apiBase });
      } else if (method === 'POST' && route === '/relay/push/token') {
        push.registerToken(payload.fcmToken);
        reply(200, { ok: true });
      } else if (method === 'POST' && route === '/relay/push/watch') {
        push.watch(payload.sessionId, payload.fcmToken);
        reply(200, { ok: true });
      } else if (method === 'POST' && route === '/relay/push/unwatch') {
        push.unwatch(payload.sessionId);
        reply(200, { ok: true });
      } else {
        reply(404, { error: 'unknown relay route ' + route });
      }
    } catch (e) {
      reply(400, { error: e.message });
    }
  }

  return { execute };
}
