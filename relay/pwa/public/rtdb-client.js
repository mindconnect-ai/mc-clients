// The phone's end of the Firebase-only tunnel: same interface as
// RelayClient, but the wire is the Realtime Database — requests become
// child nodes under tunnels/{serverId}/requests, responses stream back
// as chunk children. No relay process anywhere; the security rules in
// ../../rtdb/database.rules.json gate everything to paired device uids.
import { TunnelClient } from './client-common.js';
import { firebaseConfig, emulators } from './firebase-config.js';

const FIREBASE_VERSION = '10.12.0';
const moduleUrl = (name) =>
    `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-${name}.js`;

let firebasePromise = null;

/** Lazy one-time init: app + anonymous sign-in + database handle. */
function loadFirebase() {
  if (!firebaseConfig) return Promise.reject(new Error('firebase-config.js is not filled in'));
  firebasePromise ??= (async () => {
    const [appM, authM, dbM] = await Promise.all(
        [import(moduleUrl('app')), import(moduleUrl('auth')), import(moduleUrl('database'))]);
    const app = appM.getApps().length ? appM.getApp() : appM.initializeApp(firebaseConfig);
    const auth = authM.getAuth(app);
    const db = dbM.getDatabase(app);
    if (emulators) {
      authM.connectAuthEmulator(auth, 'http://' + emulators.auth, { disableWarnings: true });
      const [host, port] = emulators.database.split(':');
      dbM.connectDatabaseEmulator(db, host, Number(port));
    }
    // Sign in with Google by full-page redirect — no popup, so mobile
    // popup blockers can't get in the way.
    let user = null;
    try {
      // Completes a returning redirect (and surfaces sign-in errors).
      user = (await authM.getRedirectResult(auth))?.user ?? null;
    } catch (e) {
      console.warn('redirect result:', e.code, e.message);
    }
    if (!user) {
      user = await new Promise((resolve) => {
        const off = authM.onAuthStateChanged(auth, (u) => { off(); resolve(u); });
      });
    }
    if (!user) {
      // Loop breaker: if we already sent them to Google this tab-session
      // and still have no user, the browser is dropping the auth state
      // (partitioned storage) — stop instead of bouncing forever.
      if (sessionStorage.getItem('mc.redirecting')) {
        sessionStorage.removeItem('mc.redirecting');
        throw new Error('Anmeldung kam ohne Nutzer zurück — der Browser blockiert '
            + 'den Anmelde-Speicher. Bitte Seite direkt (nicht im In-App-Browser) öffnen.');
      }
      sessionStorage.setItem('mc.redirecting', '1');
      await authM.signInWithRedirect(auth, new authM.GoogleAuthProvider());
      return new Promise(() => {}); // page is navigating away to Google
    }
    sessionStorage.removeItem('mc.redirecting');
    return { f: dbM, db, uid: user.uid, email: user.email };
  })();
  return firebasePromise;
}

export class RtdbClient extends TunnelClient {
  constructor(serverId) {
    super();
    this.serverId = serverId;
    this.base = 'tunnels/' + serverId;
    this.serverOnline = null;
    this.unsubs = [];
  }

  async connect() {
    this.onstate('connecting');
    const { f, db, uid } = await loadFirebase();
    this.f = f;
    this.db = db;
    this.uid = uid;
    // The SDK reconnects on its own — these two just feed the status dot.
    this.unsubs.push(f.onValue(f.ref(db, '.info/connected'), (snap) => {
      if (!snap.val()) this.onstate('offline');
      else if (this.serverOnline != null) this.onstate(this.serverOnline ? 'online' : 'server_offline');
    }));
    this.unsubs.push(f.onValue(f.ref(db, this.base + '/online'), (snap) => {
      this.serverOnline = !!snap.val();
      this.onstate(this.serverOnline ? 'online' : 'server_offline');
      this._readyResolve();
    }, () => this.onstate('offline')));
  }

  close() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  /**
   * One tunneled HTTP request: write the frame, collect meta / chunks /
   * done from the response node, delete the node afterwards. An abort
   * deletes the request node — that is the cancel signal the connector
   * watches for.
   */
  request(method, path, { body = null, bodyBase64 = null, contentType = null,
      onChunk = null, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const { f, db } = this;
      if (!f) {
        reject(new Error('not connected'));
        return;
      }
      if (this.serverOnline === false) {
        reject(new Error('home server not connected'));
        return;
      }
      const reqRef = f.push(f.ref(db, this.base + '/requests'));
      const resRef = f.ref(db, this.base + '/responses/' + reqRef.key);
      const parts = [];
      let status = 0;
      let settled = false;
      const offs = [];
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        offs.forEach((u) => u());
        f.remove(resRef).catch(() => {});
        fn(value);
      };
      offs.push(f.onValue(f.child(resRef, 'meta'), (s) => {
        if (s.exists()) status = s.val().status ?? 0;
      }));
      offs.push(f.onChildAdded(f.child(resRef, 'chunks'), (s) => {
        parts.push(s.val());
        onChunk?.(s.val());
      }));
      offs.push(f.onValue(f.child(resRef, 'done'), (s) => {
        if (s.val()) settle(resolve, { status, text: parts.join('') });
      }));
      offs.push(f.onValue(f.child(resRef, 'error'), (s) => {
        if (s.val()) settle(reject, new Error(s.val()));
      }));
      signal?.addEventListener('abort', () => {
        if (!settled) {
          f.remove(reqRef).catch(() => {});
          settle(reject, new DOMException('aborted', 'AbortError'));
        }
      });
      const frame = { method, path, body };
      // Raw bytes (e.g. a file upload) travel base64-encoded with their own
      // content-type, so binary survives the text-only tunnel.
      if (bodyBase64 != null) { frame.bodyBase64 = bodyBase64; frame.contentType = contentType; }
      f.set(reqRef, frame).catch((e) => settle(reject, e));
    });
  }
}

/**
 * Pairing, Firebase style: sign in anonymously, read the code's node (the
 * code is the capability), claim it with our uid, wait until the
 * connector puts the uid on the allowlist.
 */
export async function pairRtdb(code) {
  code = code.trim().toUpperCase();
  const { f, db, uid } = await loadFirebase();
  const snap = await f.get(f.ref(db, 'pairings/' + code));
  if (!snap.exists()) throw new Error('unknown pairing code');
  const { serverId, expires } = snap.val();
  if (expires < Date.now()) throw new Error('pairing code expired');
  await f.set(f.ref(db, 'pairings/' + code + '/claim'), uid);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('pairing not confirmed — is the connector running?'));
    }, 15000);
    const unsub = f.onValue(f.ref(db, `tunnels/${serverId}/devices/${uid}`), (s) => {
      if (s.val()) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    }, () => {});
  });
  return { serverId };
}
