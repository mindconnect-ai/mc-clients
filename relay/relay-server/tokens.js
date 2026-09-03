import crypto from 'node:crypto';

const b64u = (data) => Buffer.from(data).toString('base64url');

function sign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * The long-lived credential a home server connects with. Deterministic —
 * generate it once with make-token.js and put it in the connector's
 * environment; the relay re-derives it instead of storing it.
 */
export function serverToken(secret, serverId) {
  return 'srv.' + b64u(serverId) + '.' + sign(secret, 'server:' + serverId);
}

export function verifyServerToken(secret, serverId, token) {
  return safeEqual(token, serverToken(secret, serverId));
}

/** Issued when a one-time pairing code is redeemed. Signed, not stored. */
export function makeDeviceToken(secret, serverId) {
  const payload = b64u(JSON.stringify({ sid: serverId, iat: Date.now() }));
  return 'dev.' + payload + '.' + sign(secret, 'device:' + payload);
}

/** @return the serverId the token is bound to, or null if invalid. */
export function verifyDeviceToken(secret, token) {
  const [kind, payload, sig] = String(token ?? '').split('.');
  if (kind !== 'dev' || !payload || !sig) return null;
  if (!safeEqual(sig, sign(secret, 'device:' + payload))) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).sid ?? null;
  } catch {
    return null;
  }
}
