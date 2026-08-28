# mc-agent-admin-launcher

A small desktop app that makes running the agent server a double-click:
download a released `mc-agent-admin-ui-app` from Maven Central, pick a
version, configure the environment, start, stop — and jump straight into the
Admin UI in the browser.

The whole window is one `UiNode` tree painted by the Semantic UI JavaFX
renderer — the same vocabulary the server-side admin pages use, with local
Java handlers (`INVOKE` triggers) instead of HTTP.

## Run

```bash
mvn -f mc-agent-admin-launcher/pom.xml javafx:run
```

## Executable jar

`package` also builds a self-contained jar with every dependency inside:

```bash
mvn -f mc-agent-admin-launcher/pom.xml package
java -jar mc-agent-admin-launcher/target/mc-agent-admin-launcher-*-all.jar
```

The JavaFX natives inside are platform-specific, so the `-all` jar runs on
the platform it was built on — build it per OS (or wire classifier profiles)
when distributing. On most desktops a double-click on the jar works once a
Java 21 runtime is installed; `jpackage` into a .dmg/.msi would remove even
that requirement.

## What it does

- **Server** — start / stop the child JVM, live status (process + TCP), the
  server log tailing into the window, a button to open the Admin UI.
- **Versions** — releases from Maven Central; download one, activate one.
  Prefers the Spring Boot executable jar (classifier `exec`); until that is
  published it falls back to resolving the runtime classpath with a local
  Maven into `lib-<version>/`.
- **Environment** — the encryption key (with a generate button), the common
  provider keys, and free-form `KEY=VALUE` lines, saved to `app.env`.
- Starting without an encryption key generates one on the fly.

## Shared home

Everything lives in `~/.mindconnect/admin-ui` (override with `MC_HOME`) — the
same directory the `scripts/run-admin-ui.*` shell scripts use, so downloads
and settings made in one show up in the other.
