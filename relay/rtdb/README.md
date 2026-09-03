# Firebase-only variant: the Realtime Database as the relay

The parallel track to the WS relay in [`../relay-server/`](../relay-server/):
no Cloud Run, no relay process anywhere. Both ends hold **outbound**
connections to Firebase (the RTDB client keeps its own WebSocket), so the
no-open-port-at-home property is unchanged — the relay shrinks to a path
structure plus security rules.

```
PHONE (PWA)  ──►  Realtime Database  ◄──  CONNECTOR (connector-rtdb.js)
  web SDK,          tunnels/{serverId}/      admin SDK, bypasses rules,
  anonymous auth,   requests|responses       ── http ──► localhost:8080
  rules-gated
```

## Path structure

| Path | Who writes | What |
|------|-----------|------|
| `tunnels/{serverId}/online` | connector | presence via `onDisconnect()` |
| `tunnels/{serverId}/devices/{uid}` | connector | allowlist — pairing puts a device's auth uid here |
| `tunnels/{serverId}/requests/{reqId}` | phone | `{method, path, body}`; the phone **deletes it to cancel** |
| `tunnels/{serverId}/responses/{reqId}` | connector | `meta {status, headers, ts}` → `chunks/*` (push children, in order) → `done` or `error`; the phone deletes the node after reading |
| `pairings/{code}` | connector | `{serverId, expires}`; the phone writes `claim: <its uid>` |

Same frames as the WS tunnel, same generic-HTTP idea — only the wire is a
database instead of a socket. Token streams are **coalesced ~150 ms** per
chunk write on the connector side; anything else would be slow and chatty
against a per-write, per-GB-billed database.

## Auth & pairing

The phone signs in **anonymously** (Firebase Auth) and gets a uid. The
connector offers a one-time code under `pairings/{code}`; the phone reads
it (the code is the capability), writes its uid as `claim`, the connector
puts the uid on `devices/` and retires the code. From then on the
[rules](database.rules.json) let exactly the listed uids touch that
server's `requests/` and `responses/` — and nothing else. The connector
itself uses the admin SDK and is not subject to the rules.

Left for later, same as on the WS track: QR instead of a typed code, auth
on `/api/**` itself, and E2E payload encryption so Firebase only ever
holds ciphertext (frames are deleted right after delivery, but they do
transit Google here).

## Setup

1. Firebase project → Realtime Database anlegen (Blaze not required —
   Spark limits are fine for personal use).
2. Deploy the rules: `firebase deploy --only database` from this folder.
3. Console → project settings → service account key → save the JSON at
   home, **not** in the repo.
4. Enable anonymous auth (Build → Authentication → Anonymous).
5. Copy `../pwa/public/firebase-config.example.js` to `firebase-config.js`
   (git-ignored) and fill it (web-app config incl.
   `databaseURL`).

Run the connector:

```bash
cd relay/connector && npm install   # pulls firebase-admin (optional dep)
SERVER_ID=my-home-server \
  RTDB_URL=https://<project>-default-rtdb.europe-west1.firebasedatabase.app \
  FIREBASE_SERVICE_ACCOUNT=/path/to/service-account.json \
  API_BASE=http://localhost:8080 node connector-rtdb.js
```

It prints a pairing code; in the PWA choose **Firebase** as the transport
and enter it.

## Local test without a Firebase project

The emulator suite (needs Java):

```bash
cd relay/rtdb
npx firebase-tools emulators:start --project demo-mc --only database,auth
```

Then point the connector at it:

```bash
FIREBASE_DATABASE_EMULATOR_HOST=localhost:19090 \
  RTDB_URL=http://localhost:19090?ns=demo-mc \
  SERVER_ID=my-home-server node connector-rtdb.js
```

## Trade-offs vs. the WS relay

* **Wins:** zero processes to run, zero standing cost (Cloud Run
  `--min-instances 1` is real money), auth + presence built in, FCM next
  door, reconnects handled by the SDK.
* **Costs:** frames briefly persist at Google (mitigate: delete after
  delivery + E2E encryption), chunk latency is DB round-trip + coalescing
  instead of raw socket, and streaming granularity is capped by the
  coalescing window.
