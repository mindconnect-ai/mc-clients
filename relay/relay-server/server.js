// The dumb switch. Authenticates both sides, pairs device ↔ server,
// forwards frames. Holds no MindConnect vocabulary and persists nothing —
// the only in-memory state is live sockets and unexpired pairing codes.
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { verifyServerToken, makeDeviceToken, verifyDeviceToken } from './tokens.js';

const PORT = Number(process.env.PORT ?? 8081);
const SECRET = process.env.RELAY_SECRET;
if (!SECRET) {
  console.error('RELAY_SECRET is required');
  process.exit(1);
}

const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_FRAME_BYTES = 1 * 1024 * 1024;

/** serverId → connector WebSocket */
const servers = new Map();
/** devId → { serverId, deliver(frame), close(reason) } — WS devices and HTTP-bridge requests alike */
const devices = new Map();
/** one-time code → { serverId, expires } */
const pairings = new Map();

let nextDevId = 1;

function pairingCode() {
  const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
  return raw.slice(0, 4) + '-' + raw.slice(4);
}

function sendJson(ws, frame) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

/** A device frame goes to its server, reqId prefixed with the device's id. */
function forwardToServer(devId, frame) {
  const device = devices.get(devId);
  const server = servers.get(device.serverId);
  if (!server) {
    if (frame.reqId) device.deliver({ reqId: frame.reqId, error: 'home server not connected' });
    return;
  }
  sendJson(server, { ...frame, reqId: devId + ':' + frame.reqId });
}

/** A server frame goes back to the device its routed reqId names. */
function forwardToDevice(frame) {
  const routed = String(frame.reqId ?? '');
  const split = routed.indexOf(':');
  if (split < 0) return;
  const device = devices.get(routed.slice(0, split));
  device?.deliver({ ...frame, reqId: routed.slice(split + 1) });
}

// ── HTTP: health, pairing, and the curl-level bridge ─────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, servers: servers.size, devices: devices.size }));
    } else if (req.method === 'POST' && url.pathname === '/pair') {
      await handlePair(req, res);
    } else if (url.pathname.startsWith('/t/')) {
      await handleBridge(req, res, url);
    } else {
      res.writeHead(404).end();
    }
  } catch (e) {
    console.error('http error', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FRAME_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Redeems a one-time pairing code for a signed device token. */
async function handlePair(req, res) {
  let code;
  try {
    code = JSON.parse(await readBody(req)).code?.toUpperCase();
  } catch {
    // fall through to the 400 below
  }
  const pairing = code && pairings.get(code);
  pairings.delete(code);
  if (!pairing || pairing.expires < Date.now()) {
    res.writeHead(pairing ? 410 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: pairing ? 'pairing code expired' : 'unknown pairing code' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    deviceToken: makeDeviceToken(SECRET, pairing.serverId),
    serverId: pairing.serverId,
  }));
}

/**
 * HTTP → tunnel bridge: `curl /t/api/… -H 'Authorization: Bearer dev.…'`.
 * Streams the connector's answer straight through, so SSE works too.
 * The build-order step-1 test path; the PWA uses the WebSocket instead.
 */
async function handleBridge(req, res, url) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const serverId = verifyDeviceToken(SECRET, token);
  if (!serverId) {
    res.writeHead(401).end();
    return;
  }
  const body = await readBody(req);
  const devId = 'h' + nextDevId++;
  const reqId = devId + ':1';
  const cleanup = () => devices.delete(devId);
  devices.set(devId, {
    serverId,
    deliver(frame) {
      if (frame.status && !res.headersSent) {
        res.writeHead(frame.status, { 'content-type': frame.headers?.['content-type'] ?? 'application/json' });
      }
      if (frame.chunk) res.write(frame.chunk);
      if (frame.error && !res.headersSent) res.writeHead(502).end(frame.error + '\n');
      if (frame.done || frame.error) {
        res.end();
        cleanup();
      }
    },
    close: cleanup,
  });
  req.on('close', () => {
    if (devices.has(devId)) {
      sendJson(servers.get(serverId), { reqId, cancel: true });
      cleanup();
    }
  });
  const connector = servers.get(serverId);
  if (!connector) {
    res.writeHead(502).end('home server not connected\n');
    cleanup();
    return;
  }
  sendJson(connector, {
    reqId,
    method: req.method,
    path: url.pathname.slice('/t'.length) + url.search,
    body: body || null,
  });
}

// ── WebSockets: /ws/server (connector) and /ws/device (PWA) ──────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://relay');
  if (url.pathname === '/ws/server') {
    const serverId = req.headers['x-server-id'];
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!serverId || !verifyServerToken(SECRET, serverId, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachServer(ws, String(serverId)));
  } else if (url.pathname === '/ws/device') {
    const serverId = verifyDeviceToken(SECRET, url.searchParams.get('token'));
    if (!serverId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachDevice(ws, serverId));
  } else {
    socket.destroy();
  }
});

function attachServer(ws, serverId) {
  servers.get(serverId)?.close(4000, 'replaced by a newer connection');
  servers.set(serverId, ws);
  ws.isAlive = true;
  console.log(`server ${serverId} connected`);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame.type === 'pair_offer') {
      const code = pairingCode();
      pairings.set(code, { serverId, expires: Date.now() + PAIRING_TTL_MS });
      sendJson(ws, { type: 'pair_code', code, expiresInSec: PAIRING_TTL_MS / 1000 });
    } else if (frame.reqId) {
      forwardToDevice(frame);
    }
  });
  ws.on('close', () => {
    if (servers.get(serverId) === ws) {
      servers.delete(serverId);
      console.log(`server ${serverId} disconnected`);
      for (const device of devices.values()) {
        if (device.serverId === serverId) device.deliver({ type: 'server_offline' });
      }
    }
  });
}

function attachDevice(ws, serverId) {
  const devId = 'd' + nextDevId++;
  devices.set(devId, {
    serverId,
    deliver: (frame) => sendJson(ws, frame),
    close: () => ws.close(),
  });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame.reqId) forwardToServer(devId, frame);
  });
  ws.on('close', () => devices.delete(devId));
  sendJson(ws, { type: 'connected', serverId, serverOnline: servers.has(serverId) });
}

// Dead-socket sweep — Cloud Run happily keeps half-open TCP around.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  for (const [code, pairing] of pairings) {
    if (pairing.expires < Date.now()) pairings.delete(code);
  }
}, 30_000).unref();

server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
