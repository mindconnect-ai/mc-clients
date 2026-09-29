# mc-chat-semantic-ui

A standalone chat client for the MindConnect agent server, built with the
**MindConnect Semantic UI** — the same UiNode components the server-side chat
UI (`mc-agent-chat-ui-rest`) renders, ported to run **in the browser** and
talk to the REST API directly.

The point of the exercise: the server builds the chat as `UiNode`s and pushes
DOM patches over SSE; here the *same components* build the *same nodes*, but on
the client, and the triggers are client-side handlers that call `/api/**`
instead of server dispatches. A companion Angular + Material client
([`../mc-chat-angular-material`](../mc-chat-angular-material)) implements the
same feature set so the two approaches can be compared by volume.

## Stack

- **Vite + TypeScript**, no framework.
- The Semantic UI runtime (`SuiRenderer` + `SuiEventBus` + the Markdown
  extension) is vendored under [`sui/`](sui/) and served at
  `/sui/*`, exactly how the framework is meant to be consumed. The chat look
  comes from the vendored [`chat-ui.css`](sui/chat-ui.css) — the same
  stylesheet the admin UI uses.

## Structure (mirrors the server components)

| File | Server counterpart |
|------|--------------------|
| [`src/model.ts`](src/model.ts) | `ai.mindconnect.ui.model.*` — a thin fluent builder layer over the node literals |
| [`src/components.ts`](src/components.ts) | `ChatShellComponent`, `MessageListComponent`, `MessageComponent`, `ApprovalCardComponent`, `ChatFormComponent`, `TaskCardComponent` |
| [`src/chat-controller.ts`](src/chat-controller.ts) | `ChatUiController.runTurnStream` — the streaming render loop |
| [`src/api.ts`](src/api.ts) | the `/api/**` REST surface + SSE frame shapes |
| [`src/main.ts`](src/main.ts) | bootstrap + the client handlers that replace server dispatch |

## Scope

The core chat: one window with an agent selector inside it (no agent list), conversation history, streaming tokens rendered
as Markdown, tool-call cards (running / done / failed), sub-agent cards,
approval cards (allow once / for session / deny), the composer (Enter sends,
Stop cancels), and file upload. Deliberately **out of scope** (server-only
machinery a client does not need): the `StreamBus` multiplex + reconnect
buffering, deeply nested sub-agent trees, the settings and attachments
dialogs, message regenerate / delete-from-here, and token-usage accounting.

## Run

```bash
npm install
MC_API=http://localhost:9090 npm run dev     # Vite proxies /api to the server
```

Open http://localhost:5174. The dev server proxies `/api` to the agent server
(default `http://localhost:9090`, override with `MC_API`).

```bash
npm run build      # tsc --noEmit + vite build → dist/
```
