# TypeScript chat clients

Two standalone chat clients for the MindConnect agent server, built to the
**same feature set** so the two UI approaches can be compared by volume:

| Folder | Approach |
|--------|----------|
| [`mc-chat-semantic-ui`](mc-chat-semantic-ui/) | MindConnect **Semantic UI** — the server's chat components (`mc-agent-chat-ui-rest`) ported to the browser: UiNodes built on the client, rendered by `SuiRenderer`, talking to the REST API. |
| [`mc-chat-angular-material`](mc-chat-angular-material/) | **Angular + Angular Material** — the same chat, idiomatic Angular standalone components. |

Both cover: conversation history, streaming tokens rendered as
Markdown, tool-call cards (running / done / failed), sub-agent cards, approval
cards (allow once / for session / deny), the composer (Enter sends, Stop
cancels), and file upload. Both consume the same `/api/**` REST surface and the
same SSE frame vocabulary.

## Volume comparison

Authored source lines (`wc -l`, excluding `node_modules`, build output, and —
for Semantic UI — the vendored framework runtime under `sui/`):

| | Semantic UI | Angular Material |
|---|---:|---:|
| App logic (components, controller/loop, API, bootstrap) | **671** | **563** |
| Model builder shim (`model.ts`, mirrors `ai.mindconnect.ui.model`) | 237 | — |
| Markdown renderer | *from framework* | 72 (`markdown.pipe.ts`) |
| **Total authored `src`** | **908** | **635** |
| Config files | 71 | 105 |
| Runtime dependency | vendored Semantic UI runtime (~40 files, compiled) | Angular + Material (858 npm packages) |
| Production bundle (app only) | ~18 kB JS + vendored `/sui` runtime | ~576 kB JS + 76 kB CSS |

### Reading the numbers

- **In the same ballpark.** Raw authored lines land ~872 vs ~617. The gap is
  almost entirely the **229-line `model.ts` builder shim** the Semantic UI
  client adds so its components can read like the server's Java
  (`UiList.of(...).item(...)`); the web framework itself ships only node
  literals. Take that shim as framework glue and the *app logic* is **643 vs
  545** — very close.
- **What each side gets for free.** Semantic UI hands the client Markdown
  rendering and the exact admin-UI chat CSS (`chat-ui.css`) from the framework;
  the Angular client hand-writes a 72-line Markdown pipe and its own styles.
- **Dependency weight is the real divergence.** The Semantic UI client vendors
  a small compiled runtime and ships an ~18 kB app bundle. The Angular client
  pulls 858 npm packages and ships a ~576 kB bundle — the cost of the framework
  and Material.
- **Structure.** The Semantic UI client is a near-1:1 port of the server
  components (same ids, css classes, patch shapes), so server and client share
  one mental model. The Angular client is a conventional component tree with
  `*ngFor` over a `ChatItem` union and Material widgets — familiar to any
  Angular developer, but a separate model from the server.

Run each with its own README.
