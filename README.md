# mc-clients

Desktop and mobile clients for the MindConnect platform, grouped by
technology. Every client paints its UI from the same `UiNode` vocabulary the
server-side admin pages use — the [Semantic UI](https://github.com/mindconnect-ai/mc-semantic-ui)
renderers do the drawing, the client supplies local handlers.

| Folder | Technology | Status |
|--------|------------|--------|
| [`javafx/`](javafx/) | JavaFX desktop clients | active |
| `ios/` | Swift / iOS clients | idea — depends on a Semantic UI Swift renderer |

## JavaFX clients

The `javafx/` folder is a standalone Maven build — parent POM and platform
artifacts come released from Maven Central:

```bash
mvn -f javafx/pom.xml clean package
```

| Module | Purpose |
|--------|---------|
| [`mc-server-control`](javafx/mc-server-control/) | Manage the locally installed server (download, environment, start/stop, pid-file adoption) — no UI |
| [`mc-server-control-fx`](javafx/mc-server-control-fx/) | The server-control panels as embeddable Semantic UI JavaFX components |
| [`mc-agent-admin-launcher`](javafx/mc-agent-admin-launcher/) | Run the agent server: download a release, pick a version, configure the environment, start / stop, open the Admin UI |
| [`mc-agent-chat`](javafx/mc-agent-chat/) | End-user chat client — work in progress, not part of the release yet |

Planned: a workflow client.

## Download

End-user builds are native installers with a bundled Java runtime — no local
Java needed. They are built by [`release.yml`](.github/workflows/release.yml)
whenever a `v*` tag is pushed, one per platform, and attached to the GitHub
release: `.dmg` (macOS arm64 + x64), `.msi` (Windows), `.deb` (Linux).

Local build of the installer for the current platform:

```bash
mvn -f javafx/pom.xml -pl mc-agent-admin-launcher -Pinstaller package jpackage:jpackage -Djpackage.type=DMG
```

(`DMG` on macOS; `MSI` on Windows, `DEB`/`RPM` on Linux.)
