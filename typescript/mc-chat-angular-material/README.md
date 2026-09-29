# mc-chat-angular-material

The same standalone chat client as
[`../mc-chat-semantic-ui`](../mc-chat-semantic-ui), built with **Angular +
Angular Material** instead of the MindConnect Semantic UI. Same feature set,
same REST API — the point is to compare the two approaches by volume.

## Stack

- **Angular 17** (standalone components, no NgModules).
- **Angular Material** for the UI (sidenav, list, cards, form field, buttons,
  snackbar, toolbar) + a Material dark theme.
- SSE consumed with `fetch` + a stream reader (the chat endpoint takes a
  text/plain body and streams `text/event-stream`, which `EventSource` can't).

## Structure

| File | Responsibility |
|------|----------------|
| [`src/app/app.component.ts`](src/app/app.component.ts) | Shell: agent selector (toolbar), conversation drawer, content |
| [`src/app/chat.component.ts`](src/app/chat.component.ts) | The conversation, composer, and the streaming render loop |
| [`src/app/api.service.ts`](src/app/api.service.ts) | The `/api/**` REST surface + SSE reader |
| [`src/app/markdown.pipe.ts`](src/app/markdown.pipe.ts) | Safe Markdown → HTML for chat bubbles |
| [`src/app/models.ts`](src/app/models.ts) | Domain + `ChatItem` view models |

## Scope

Identical to the Semantic UI client: one window with an agent selector inside it, history, streaming tokens
as Markdown, tool cards (running / done / failed), sub-agent cards, approval
cards, composer (Enter sends, Stop cancels), file upload.

## Run

```bash
npm install
npm start          # ng serve, proxies /api to http://localhost:9090
```

Open http://localhost:4300.

```bash
npm run build      # ng build → dist/
```
