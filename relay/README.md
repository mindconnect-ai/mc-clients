# MindConnect Mobile Relay

Start an agent session at the desk, keep writing — and answer tool
approvals — from the phone, without ever exposing the home server to the
internet. The trick: the server dials **out** to a small, stateless relay;
the phone meets it there.

```
PHONE (PWA)  ── wss ──►  RELAY (Cloud Run)  ◄── wss ──  CONNECTOR (home)
                          stateless, pairs                ── http ──►
                          device ↔ server                 localhost:8080
                                                          (mc-agent-api-app)
```

Both ends dial in. No port forwarding, no inbound connection at home. The
connector replays tunneled requests against the unchanged REST API on
`localhost:8080`. A dashed side path goes through FCM so the phone rings
when an agent is waiting for an approval.

## Folders

| Folder | What it is |
|--------|------------|
| [`relay-server/`](relay-server/) | The dumb switch — Node.js, made for Cloud Run. Authenticates both sides, pairs device ↔ server, forwards frames. Persists nothing. |
| [`connector/`](connector/) | `mc-agent-remote-connector` — runs next to the agent server at home. Replays tunnel frames against the local API ([`api-proxy.js`](connector/api-proxy.js)), holds standing attaches on watched sessions and turns `approval_requested` / `done` into push notifications. Two entrypoints, one per transport: [`connector.js`](connector/connector.js) (WS relay) and [`connector-rtdb.js`](connector/connector-rtdb.js) (Firebase-only). |
| [`pwa/`](pwa/) | The phone client for Firebase Hosting. Session list, chat with a stream-reattach loop, approval cards. Modeled on the JavaFX `ApiClient` — same endpoints, same frames, transport chosen at pairing time. |
| [`rtdb/`](rtdb/) | The parallel **Firebase-only variant**: the Realtime Database is the relay — no Cloud Run, no relay process. Security rules + setup, see its [README](rtdb/README.md) and the step-by-step [SETUP.md](rtdb/SETUP.md) (plus [`setup-firebase.sh`](rtdb/setup-firebase.sh)). |

## Your own Firebase project

Three files name a concrete Firebase project and are therefore git-ignored;
each has a committed `*.example*` twin with placeholders. Copy and fill in:

| Ignored file | Template | Holds |
|--------------|----------|-------|
| `pwa/public/firebase-config.js` | `firebase-config.example.js` | the web-app config (`firebase apps:sdkconfig WEB`) |
| `pwa/firebase.json` | `firebase.example.json` | the Hosting site names |
| `rtdb/.firebaserc` | `.firebaserc.example` | the default project for the Firebase CLI |

Nothing else in this folder is instance-specific; the connector's own
settings live outside the repo in `~/.mindconnect/admin-ui/connector.properties`.

## Tunnel protocol: generic HTTP

The relay knows no MindConnect vocabulary. It forwards raw HTTP requests
as JSON frames — the phone therefore speaks the complete existing REST
API, and the relay never needs touching when the API grows.

Phone → relay → connector:

```json
{ "reqId": "r-4711",
  "method": "GET",
  "path": "/api/sessions/9f2…/stream?afterSeq=182",
  "body": null }
```

Connector → relay → phone:

```json
{ "reqId": "r-4711", "status": 200, "headers": { "content-type": "text/event-stream" } }
{ "reqId": "r-4711", "chunk": "data:{\"seq\":183,…}\n\n" }
{ "reqId": "r-4711", "chunk": "data:{\"seq\":184,…}\n\n" }
{ "reqId": "r-4711", "done": true }
```

A `{ "reqId": "r-4711", "cancel": true }` from the phone aborts the
request at the connector (used when a stream attach is superseded).
Bodies travel as UTF-8 text — the API is JSON and SSE throughout.

## The approval round-trip

The core case. The agent turn is never aborted — it parks on a suspended
tool task and continues on the same stream after the answer. The phone
re-enters with its last `seq` cursor:

1. A tool call needs approval; the API persists `APPROVAL_REQUEST` and
   emits `approval_requested` on the session stream.
2. The connector's standing attach sees the frame → FCM push:
   *"Agent is waiting for an approval."*
3. The phone opens, attaches `GET /api/sessions/{id}/stream?afterSeq=182`
   through the tunnel — replay from seq 183, then live.
4. `POST /api/sessions/{id}/approvals/{callId}?approved=true&scope=once`
   — the parked tool task wakes up, the turn continues, live tokens keep
   flowing over the already-attached stream.

The `afterSeq` cursor lives in the PWA's localStorage — that is what
survives app switches, dead spots, and the 120-second timeout of the
server's SSE emitters.

## Pairing & auth

* The **connector** authenticates with a server token derived from
  `RELAY_SECRET` (generate it once with `relay-server/make-token.js`).
* A device pairs by scanning a **one-time code** the connector prints
  (later: QR in the admin UI). The relay exchanges the code for a signed
  device token — stateless, HMAC over `RELAY_SECRET`, nothing stored.
* The relay only ever sees frames; end-to-end payload encryption can be
  layered on later so it only sees ciphertext.
* Note: the local API itself has no auth today — the tunnel's device
  token is the effective gate. Minimal auth on `/api/**` is a follow-up.

## Build order

1. **Connector + relay** — the tunnel stands, testable with `curl`
   through the relay (see below).
2. **Pairing and tokens** (QR in the admin UI, auth on the API).
3. **PWA** with session list, reattach loop, and approval cards.
4. **FCM push** for `approval_requested` and `done`.

## Running it locally

Relay (any machine, later Cloud Run):

```bash
cd relay/relay-server && npm install
RELAY_SECRET=devsecret node server.js            # listens on :8081
```

Connector (on the machine that runs the agent server):

```bash
cd relay/connector && npm install
node ../relay-server/make-token.js devsecret my-home-server   # prints SERVER_TOKEN
RELAY_URL=ws://localhost:8081 SERVER_ID=my-home-server \
  SERVER_TOKEN=srv.… API_BASE=http://localhost:8080 node connector.js
```

On start the connector requests a pairing code from the relay and prints
it. Exchange it for a device token, then talk to the home API from
anywhere — the relay's HTTP bridge (`/t/…`) exists exactly for this
curl-level test; the PWA uses the WebSocket path:

```bash
curl -s -X POST http://localhost:8081/pair -d '{"code":"ABCD-1234"}' \
  -H 'content-type: application/json'
# → { "deviceToken": "dev.…", "serverId": "my-home-server" }

curl -s http://localhost:8081/t/api/agents?namespace=local \
  -H 'Authorization: Bearer dev.…'
```

PWA (needs the relay reachable from the phone):

```bash
cd relay/pwa && npx serve public      # or: firebase deploy --only hosting
```

## Deploying the relay to Cloud Run

Firebase Functions won't do — they don't hold long-lived WebSockets.
Cloud Run does:

```bash
cd relay/relay-server
gcloud run deploy mc-relay --source . --region europe-west1 \
  --set-env-vars RELAY_SECRET=… --allow-unauthenticated \
  --min-instances 1 --timeout 3600
```

`--min-instances 1` keeps the instance (and its WebSockets) alive;
`--timeout 3600` is the per-connection ceiling — both ends reconnect
with backoff anyway.
