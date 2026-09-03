// mc-agent-remote-connector, Firebase-only transport — no relay process
// anywhere. The Realtime Database IS the relay: both ends hold outbound
// connections to Firebase, requests arrive as child nodes, responses go
// back as coalesced chunk children. Rules live in ../rtdb/database.rules.json;
// this side uses the admin SDK and bypasses them.
//
//   tunnels/{serverId}/online            presence (onDisconnect)
//   tunnels/{serverId}/devices/{uid}     allowlist, written on pairing
//   tunnels/{serverId}/requests/{reqId}  {method, path, body} — phone writes,
//                                        phone deletes to cancel
//   tunnels/{serverId}/responses/{reqId} {meta, chunks/*, done|error} —
//                                        phone deletes after done
//   pairings/{code}                      {serverId, expires, claim?}
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PushWatcher } from './push.js';
import { createProxy } from './api-proxy.js';

const SERVER_ID = process.env.SERVER_ID;
const RTDB_URL = process.env.RTDB_URL;
const API_BASE = process.env.API_BASE ?? 'http://localhost:8080';
const STATE_FILE = process.env.CONNECTOR_STATE ?? new URL('./connector-state.json', import.meta.url).pathname;

// Tokens stream as many tiny SSE frames; writing each one to the RTDB
// would be slow and chatty. Buffered ~6 writes/s still reads as live.
const COALESCE_MS = 150;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const RESPONSE_TTL_MS = 10 * 60 * 1000;

if (!SERVER_ID || !RTDB_URL) {
  console.error('SERVER_ID and RTDB_URL are required, e.g. '
      + 'RTDB_URL=https://<project>-default-rtdb.europe-west1.firebasedatabase.app');
  process.exit(1);
}
// With credentials (or the emulator) the admin SDK is the right tool: it
// bypasses the rules. Without any, fall back to the *client* SDK — that
// only works while the no-sec rules (database.rules.nosec.json) are
// deployed, where the random SERVER_ID is the only thing gating access.
let db;
if (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS
    || process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  const admin = (await import('firebase-admin')).default;
  admin.initializeApp({
    databaseURL: RTDB_URL,
    ...(process.env.FIREBASE_SERVICE_ACCOUNT ? {
      credential: admin.credential.cert(
          JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT, 'utf8'))),
    } : {}),
  });
  db = admin.database();
} else {
  console.warn('⚠  no credentials — using the client SDK without auth.');
  console.warn('⚠  This only works with the NO-SEC rules deployed; the random');
  console.warn('⚠  SERVER_ID is the only gate. Temporary setups only.');
  const firebase = (await import('firebase/compat/app')).default;
  await import('firebase/compat/database');
  firebase.initializeApp({ databaseURL: RTDB_URL });
  db = firebase.database();
}

const push = new PushWatcher(API_BASE, STATE_FILE);
await push.init();
const proxy = createProxy({ apiBase: API_BASE, serverId: SERVER_ID, push });

const root = db.ref('tunnels/' + SERVER_ID);
const inflight = new Map(); // reqId → AbortController

// A previous run may have left half-answered frames behind.
await root.child('requests').remove();
await root.child('responses').remove();
root.child('online').onDisconnect().set(false);
await root.child('online').set(true);

// ── Tunnel ───────────────────────────────────────────────────────────────

root.child('requests').on('child_added', (snap) => handle(snap.key, snap.val()));
// The phone cancels by deleting its request node (we delete it ourselves
// after done — aborting an already finished request is a no-op).
root.child('requests').on('child_removed', (snap) => inflight.get(snap.key)?.abort());

async function handle(reqId, frame) {
  if (!frame?.method || !frame?.path) return;
  const resRef = root.child('responses/' + reqId);
  const ctrl = new AbortController();
  inflight.set(reqId, ctrl);

  let buffer = '';
  let timer = null;
  const flush = () => {
    timer = null;
    if (buffer) {
      resRef.child('chunks').push(buffer);
      buffer = '';
    }
  };
  const finish = (leaf, value) => {
    clearTimeout(timer);
    flush();
    resRef.child(leaf).set(value);
    inflight.delete(reqId);
    root.child('requests/' + reqId).remove();
  };

  try {
    await proxy.execute(frame, {
      status: (status, headers) => resRef.child('meta').set({ status, headers, ts: Date.now() }),
      chunk: (text) => {
        buffer += text;
        timer ??= setTimeout(flush, COALESCE_MS);
      },
      done: () => finish('done', true),
      error: (message) => finish('error', message),
    }, ctrl.signal);
  } finally {
    inflight.delete(reqId);
  }
}

// The phone deletes responses it has read; this sweep catches the ones a
// phone that never came back left behind.
setInterval(async () => {
  const snap = await root.child('responses').get();
  const now = Date.now();
  snap.forEach((res) => {
    const ts = res.child('meta/ts').val() ?? 0;
    if (now - ts > RESPONSE_TTL_MS) root.child('responses/' + res.key).remove();
  });
}, 60_000);

// ── Pairing (optional) ─────────────────────────────────────────────────
// Off by default: the codeless rules gate the tunnel on a hardwired Google
// address, so no per-device claim is needed. Set REQUIRE_PAIRING=1 to fall
// back to the multi-device pairing-code flow (with database.rules.multidevice.json).

async function offerPairing() {
  const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
  const code = raw.slice(0, 4) + '-' + raw.slice(4);
  const pairRef = db.ref('pairings/' + code);
  await pairRef.set({ serverId: SERVER_ID, expires: Date.now() + PAIRING_TTL_MS });
  console.log('──────────────────────────────────────────────');
  console.log(`  Pairing code for a new device: ${code}`);
  console.log(`  (valid ${PAIRING_TTL_MS / 60000} min — later: QR in the admin UI)`);
  console.log('──────────────────────────────────────────────');
  const claimRef = pairRef.child('claim');
  claimRef.on('value', async (snap) => {
    const uid = snap.val();
    if (!uid) return;
    claimRef.off();
    await root.child('devices/' + uid).set(true);
    await pairRef.remove();
    console.log(`device ${uid} paired`);
    offerPairing();
  });
  setTimeout(() => {
    claimRef.off();
    pairRef.get().then((s) => {
      // Expired unclaimed — retire it and offer a fresh one.
      if (s.exists() && !s.child('claim').exists()) {
        pairRef.remove();
        offerPairing();
      }
    });
  }, PAIRING_TTL_MS).unref();
}

if (process.env.REQUIRE_PAIRING) {
  offerPairing();
} else {
  console.log('codeless mode — access gated by the hardwired email in the security rules.');
}
console.log(`rtdb connector up as ${SERVER_ID} → ${RTDB_URL} (api ${API_BASE})`);
