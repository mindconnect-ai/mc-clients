// Standing attaches → push. Watches session streams on the local API and
// turns approval_requested / done / error frames into FCM notifications.
// Without FCM configured it degrades to log lines, so the tunnel part of
// the connector is testable long before Firebase exists.
import { readFileSync, writeFileSync } from 'node:fs';

const RETRY_MS = 3_000;

export class PushWatcher {
  /**
   * @param apiBase   e.g. http://localhost:8080
   * @param stateFile JSON file keeping fcm tokens + watched sessions across restarts
   */
  constructor(apiBase, stateFile) {
    this.apiBase = apiBase;
    this.stateFile = stateFile;
    this.state = { fcmTokens: [], sessions: {} }; // sessions: id → lastSeenSeq
    this.loops = new Map(); // sessionId → AbortController
    this.messaging = null;
    try {
      this.state = { ...this.state, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
    } catch {
      // first start — nothing persisted yet
    }
  }

  async init() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        const admin = (await import('firebase-admin')).default;
        // connector-rtdb.js initializes the app itself (with databaseURL);
        // only create one here when we run under the WS connector.
        if (!admin.apps.length) {
          admin.initializeApp({
            credential: admin.credential.cert(
                JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT, 'utf8'))),
          });
        }
        this.messaging = admin.messaging();
        console.log('push: FCM ready');
      } catch (e) {
        console.error('push: FCM unavailable, falling back to log lines —', e.message);
      }
    } else {
      console.log('push: FIREBASE_SERVICE_ACCOUNT not set — notifications go to the log');
    }
    for (const sessionId of Object.keys(this.state.sessions)) this.#startLoop(sessionId);
  }

  registerToken(fcmToken) {
    if (fcmToken && !this.state.fcmTokens.includes(fcmToken)) {
      this.state.fcmTokens.push(fcmToken);
      this.#save();
    }
  }

  watch(sessionId, fcmToken) {
    this.registerToken(fcmToken);
    if (!(sessionId in this.state.sessions)) {
      this.state.sessions[sessionId] = 0;
      this.#save();
    }
    this.#startLoop(sessionId);
  }

  unwatch(sessionId) {
    delete this.state.sessions[sessionId];
    this.#save();
    this.loops.get(sessionId)?.abort();
    this.loops.delete(sessionId);
  }

  #save() {
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  /**
   * One reattach loop per watched session: attach after the last seen seq,
   * read until the server's SSE emitter times out (120 s), attach again.
   */
  #startLoop(sessionId) {
    if (this.loops.has(sessionId)) return;
    const ctrl = new AbortController();
    this.loops.set(sessionId, ctrl);
    (async () => {
      while (!ctrl.signal.aborted && sessionId in this.state.sessions) {
        try {
          await this.#attachOnce(sessionId, ctrl.signal);
        } catch (e) {
          if (ctrl.signal.aborted) break;
          console.error(`push: stream ${sessionId} — ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
      this.loops.delete(sessionId);
    })();
  }

  async #attachOnce(sessionId, signal) {
    const afterSeq = this.state.sessions[sessionId] ?? 0;
    const res = await fetch(
        `${this.apiBase}/api/sessions/${sessionId}/stream?afterSeq=${afterSeq}`,
        { headers: { accept: 'text/event-stream' }, signal });
    if (res.status === 404) {
      // Session gone (or a server from before the stream endpoint) — stop watching.
      this.unwatch(sessionId);
      return;
    }
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) this.#onFrame(sessionId, JSON.parse(line.slice(5)));
      }
    }
  }

  #onFrame(sessionId, frame) {
    if (frame.type === 'attached') return;
    if (frame.seq) {
      this.state.sessions[sessionId] = frame.seq;
      this.#save();
    }
    const type = frame.event?.type;
    if (type === 'approval_requested') {
      this.#notify('Agent wartet auf Freigabe',
          `${frame.event.toolName ?? 'Ein Tool'} möchte ausgeführt werden.`, sessionId);
    } else if (type === 'done' || type === 'error') {
      this.#notify(type === 'error' ? 'Turn fehlgeschlagen' : 'Turn fertig',
          frame.event.finalText?.slice(0, 120) ?? frame.event.error ?? '', sessionId);
    }
  }

  #notify(title, body, sessionId) {
    if (!this.messaging || this.state.fcmTokens.length === 0) {
      console.log(`push [${sessionId}]: ${title} — ${body}`);
      return;
    }
    this.messaging.sendEachForMulticast({
      tokens: this.state.fcmTokens,
      notification: { title, body },
      data: { sessionId },
    }).then((r) => {
      // Drop tokens FCM no longer knows, so dead installs stop accumulating.
      const dead = r.responses
          .map((resp, i) => (resp.error?.code === 'messaging/registration-token-not-registered'
              ? this.state.fcmTokens[i] : null))
          .filter(Boolean);
      if (dead.length) {
        this.state.fcmTokens = this.state.fcmTokens.filter((t) => !dead.includes(t));
        this.#save();
      }
    }).catch((e) => console.error('push: send failed —', e.message));
  }
}
