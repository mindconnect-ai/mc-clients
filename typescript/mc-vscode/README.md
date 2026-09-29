# MindConnect for VS Code

Runs the MindConnect agent server on your machine and puts its agents into the
VS Code chat as **`@mindconnect`** — with the workspace folder, file,
selection and problems you are looking at.

## What it does

| Part | How |
|------|-----|
| **MindConnect view** | An activity bar entry like Source Control or Extensions. *Server*: status, start / restart / stop, release from Maven Central or a local jar (file picker), Java home, environment variables — names with KEY, SECRET, TOKEN or PASSWORD go to the OS keychain, not to settings.json. *Admin UI*: the Admin UI itself, without an address bar; the title bar opens it as an editor tab for more room. |
| **Local server** | Downloads the Admin UI app's executable jar from Maven Central (after asking — it is large), runs it with Java 21 on a free port bound to `127.0.0.1`, file persistence under the extension's global storage. Status bar item, output channel *MindConnect Server*, stops with the window. |
| **`@mindconnect` chat participant** | Each VS Code chat is one server session; the session id travels in the answer's metadata. Tokens stream as Markdown, tool calls and sub-agents show as progress, approvals come up as a modal dialog. |
| **Editor context** | Sent ahead of every message: workspace folder, Git branch, active file with selection (or ±20 lines around the cursor), its errors and warnings, the other visible files, and anything attached with `#file` / `#selection`. Unsaved changes travel as text. |
| **Back channel** | The agent changes files through VS Code, not behind its back: an MCP server inside the extension offers `edit_file`, `write_file`, `open_file` and `get_diagnostics`; the MindConnect server reaches it through its MCP gateway as `vscode_*` tools. A change opens as a diff — Accept / Reject in the editor title — and only an accepted one is applied, as a `WorkspaceEdit` on the buffer (undo works, unsaved changes are part of it) and saved. |
| **Working directory** | The session works in the workspace folder of the active file — the agent's file tools start there, and the project's `.mindconnect/skills/` and `AGENTS.md` apply. Switching to a file in another folder moves the session along. |

The default agent is `vscode-assistant`, which the extension creates on the
first start: a copy of the seed data's `coding-assistant` with `file_edit` /
`file_write` swapped for the reviewed VS Code tools. `/agent` or
*MindConnect: Select Agent* picks another, `/new` starts a fresh session.

### How the back channel is wired

```
@mindconnect ──REST/SSE──▶ MindConnect server ──LLM──▶ tool call vscode_edit_file
                                  │
                                  └─ MCP gateway ──streamable HTTP, bearer token──▶ extension (127.0.0.1)
                                                                                     └─ diff ▶ Accept ▶ WorkspaceEdit + save
```

- The registration is a file the extension drops into the managed server's
  data directory (`<data>/local/system/mcp-servers/vscode.json`); the gateway
  re-reads that directory, no restart needed. With an external server there is
  no back channel, and the chat falls back to `coding-assistant`.
- The gateway gives up on a tool call after 60 s, so a proposal waits 50 s for
  the decision; after that the agent hears “still awaiting review”, and a later
  Accept is still applied.
- The Admin UI is framed through a small reverse proxy in the extension: the
  server sends `X-Frame-Options: SAMEORIGIN`, and its session cookie would
  not travel in an iframe under a `vscode-webview://` page. The proxy drops
  the header and keeps the cookies itself — one local user, one jar.
- The tool server is stateless (a fresh MCP server per request), so either side
  can restart without an MCP session to recover.

## Security

The managed server runs with authentication off — it is meant for one user on
this machine. What keeps other parties out:

| Threat | Guard |
|--------|-------|
| Other machines | The server, the Admin UI proxy and the tool server bind to `127.0.0.1` only. |
| A web page in the browser calling the API (CORS, simple POSTs) | `MINDCONNECT_CORS_ALLOWEDORIGINS` is set to the server's own origin; Spring rejects every other origin with 403 before a handler runs. Origins in `mindconnect.server.env` are added, not substituted. |
| A web page framing or calling the Admin UI proxy | `frame-ancestors 'self' vscode-webview: vscode-file:` instead of `X-Frame-Options`; cross-site requests are refused except the webview's GET that loads the frame (`Sec-Fetch-*`, `Origin`). |
| DNS rebinding against the proxy | A `Host` other than `127.0.0.1:<port>` / `localhost:<port>` is refused. |
| DNS rebinding against the server itself | **Open** — needs a Host allow-list in the server (planned). |
| Anyone else calling the tool server | Bearer token, random per window, stored only in the registration file (mode 600). |
| A tampered download | The jar's SHA-512 is checked against Maven Central's `.sha512` before it is installed; a jar from before that check is verified on the next start. |
| API keys in plain text | Environment variables named `*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*` go to the OS keychain; the encryption key too. |

## Host theme (Admin UI inside VS Code)

The Admin UI view loads the UI with `?mc-host=vscode` and hands it VS Code's
colours by `postMessage`, so a theme in the UI can follow the editor's theme:

```js
// webview → Admin UI frame, on load, on request and on every theme change
{ type: "mc-host-theme", version: 1, host: "vscode",
  kind: "dark" | "light" | "high-contrast" | "high-contrast-light",
  vars: { "--vscode-editor-background": "#1f1f1f", "--vscode-foreground": "#cccccc", … } }

// Admin UI frame → webview, when its listener is in place
{ type: "mc-host-ready" }
```

### Previewing the theme without VS Code

`dev/theme-preview/` holds a prototype of the Admin UI side — `vscode.css`
(the theme overlay) and `bridge.js` (the receiver) — and a page that plays
VS Code with the colours of Dark Modern, Light Modern and High Contrast, at
side bar and editor width. It proxies any running server and injects both
files, so nothing on the server changes:

```bash
node dev/theme-preview/serve.mjs http://127.0.0.1:<server-port>
```

Then open <http://localhost:18780/__preview/>. The files are read on every
request — edit, reload.

## Run it from source

```bash
npm install
npm run compile
```

Open this folder in VS Code and press **F5** — an Extension Development Host
starts with the extension loaded. Open the chat and type `@mindconnect`.

Needs Java 21+ (`JAVA_HOME`, the `PATH`, or `mindconnect.server.javaHome`).
LLM configs are set in the Admin UI (*MindConnect: Open Admin UI*) — without
one the agent answers with a “no API key” error.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `mindconnect.server.mode` | `managed` | `managed`: the extension runs the server. `external`: connect to `mindconnect.server.url`. |
| `mindconnect.server.url` | `http://localhost:9090` | Server in external mode. |
| `mindconnect.server.version` | `latest` | Release to download, e.g. `0.8.4`. |
| `mindconnect.server.jarPath` | — | Run a local build instead (`mc-agent-admin-ui-app-*-exec.jar`). |
| `mindconnect.server.javaHome` | — | Java 21+ to run it with. |
| `mindconnect.server.autoStart` | `true` | Start the server when the chat first needs it. |
| `mindconnect.server.env` | `{}` | Extra environment for the managed server — the plain part; secrets entered in the Server view live in the keychain. |
| `mindconnect.agent` | `vscode-assistant` | Agent name or id for `@mindconnect`. |

The managed server gets `MINDCONNECT_TOOLS_WORKINGDIRROOT` set to the file
system root, so a project outside the home directory can be the working
directory too. Its `MINDCONNECT_ENCRYPTION_SECRET_KEY` (it encrypts stored LLM
credentials and has no default) is generated once and kept in VS Code's
secret storage.

## Layout

```
src/
  extension.ts             activation, commands, status bar menu
  server/serverManager.ts  start / stop / readiness / status bar / log
  server/releases.ts       Maven Central download, Java 21 lookup
  api/client.ts            REST + SSE client for /api/**
  context/editorContext.ts what the agent learns about the editor
  chat/participant.ts      @mindconnect: sessions, streaming, approvals
  backchannel/
    toolServer.ts          MCP server with the VS Code tools
    proposals.ts           diff view, Accept / Reject, WorkspaceEdit
    provisioning.ts        gateway registration, vscode-assistant
    backChannel.ts         sets it up whenever a managed server comes up
  server/envStore.ts       environment: settings + secret storage
  ui/serverView.ts         the Server view — form over the settings
  ui/adminUiView.ts        the Admin UI view and editor tab
  ui/adminUiProxy.ts       frames the Admin UI: header, cookies, redirects
  test/                    integration tests in a real VS Code
```

## Tests

`npm test` starts a separate VS Code (downloaded into `.vscode-test/` on the
first run) on `test-fixtures/workspace` and runs the back-channel suite: an
MCP client plays the gateway, the test clicks Accept / Reject. The stable
VS Code only runs tests from the command line while no other instance is
open — with VS Code open, use the **Extension Tests** launch configuration
(F5) instead.

## Next steps

- **Several windows**: the registration names one tool server, so with two
  VS Code windows the last one started receives the proposals. Needs the
  session (or its working directory) to reach the MCP call.
- **Client-side tools in the runtime** (`clientTools`, concept K7) would let
  the tools travel with the chat request instead of a registration file.
- **MCP server definition provider**: register MindConnect so Copilot's agent
  mode can use its agents and workflows as tools.
- **Language model chat provider**: the server's LLM configs in VS Code's
  model picker.
- **Webview chat** in the secondary sidebar for editors without the chat view
  (VSCodium, Cursor).
- **Smaller download**: the exec jar is ~360 MB; a slimmer local server
  distribution or a platform-specific VSIX with a jlink runtime.
- **Tests** with `@vscode/test-electron`; Marketplace and Open VSX publishing.
