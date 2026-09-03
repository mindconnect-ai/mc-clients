// mc-agent-remote-connector, WS-relay transport — runs next to the agent
// server at home. Dials OUT to the relay (no inbound port), replays
// tunneled HTTP frames against the unchanged REST API on localhost, and
// keeps standing attaches on watched sessions so the phone gets a push
// when an agent is waiting. The Firebase-only sibling is connector-rtdb.js.
import WebSocket from 'ws';
import { PushWatcher } from './push.js';
import { createProxy } from './api-proxy.js';

const RELAY_URL = process.env.RELAY_URL ?? 'ws://localhost:8081';
const SERVER_ID = process.env.SERVER_ID;
const SERVER_TOKEN = process.env.SERVER_TOKEN;
const API_BASE = process.env.API_BASE ?? 'http://localhost:8080';
const STATE_FILE = process.env.CONNECTOR_STATE ?? new URL('./connector-state.json', import.meta.url).pathname;

if (!SERVER_ID || !SERVER_TOKEN) {
  console.error('SERVER_ID and SERVER_TOKEN are required '
      + '(generate the token with relay-server/make-token.js)');
  process.exit(1);
}

const push = new PushWatcher(API_BASE, STATE_FILE);
await push.init();
const proxy = createProxy({ apiBase: API_BASE, serverId: SERVER_ID, push });

/** reqId → AbortController, so a cancel frame can stop a running stream. */
const inflight = new Map();

let backoffMs = 1_000;

function connect() {
  const ws = new WebSocket(RELAY_URL.replace(/\/$/, '') + '/ws/server', {
    headers: { 'x-server-id': SERVER_ID, authorization: 'Bearer ' + SERVER_TOKEN },
  });

  ws.on('open', () => {
    backoffMs = 1_000;
    console.log(`connected to relay ${RELAY_URL} as ${SERVER_ID}`);
    ws.send(JSON.stringify({ type: 'pair_offer' }));
  });

  ws.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame.type === 'pair_code') {
      console.log('──────────────────────────────────────────────');
      console.log(`  Pairing code for a new device: ${frame.code}`);
      console.log(`  (valid ${Math.round(frame.expiresInSec / 60)} min — later: QR in the admin UI)`);
      console.log('──────────────────────────────────────────────');
    } else if (frame.cancel) {
      inflight.get(frame.reqId)?.abort();
    } else if (frame.reqId && frame.method) {
      handleRequest(ws, frame);
    }
  });

  ws.on('close', () => {
    for (const ctrl of inflight.values()) ctrl.abort();
    inflight.clear();
    const jitter = Math.random() * 0.3 + 0.85;
    const delay = Math.round(backoffMs * jitter);
    console.log(`relay connection lost — reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
    backoffMs = Math.min(backoffMs * 2, 60_000);
  });

  ws.on('error', (e) => console.error('relay socket:', e.message));
}

const send = (ws, frame) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
};

async function handleRequest(ws, frame) {
  const { reqId } = frame;
  const ctrl = new AbortController();
  inflight.set(reqId, ctrl);
  try {
    await proxy.execute(frame, {
      status: (status, headers) => send(ws, { reqId, status, headers }),
      chunk: (chunk) => send(ws, { reqId, chunk }),
      done: () => send(ws, { reqId, done: true }),
      error: (error) => send(ws, { reqId, error }),
    }, ctrl.signal);
  } finally {
    inflight.delete(reqId);
  }
}

connect();
