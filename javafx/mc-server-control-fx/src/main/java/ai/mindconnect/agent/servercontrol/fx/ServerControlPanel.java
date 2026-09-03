package ai.mindconnect.agent.servercontrol.fx;

import ai.mindconnect.agent.servercontrol.ServerReleases;
import ai.mindconnect.agent.servercontrol.ServerHome;
import ai.mindconnect.agent.servercontrol.ServerProcess;
import ai.mindconnect.ui.javafx.SuiFxEventBus;
import ai.mindconnect.ui.model.UiAction;
import ai.mindconnect.ui.model.UiColumn;
import ai.mindconnect.ui.model.UiDialog;
import ai.mindconnect.ui.model.UiField;
import ai.mindconnect.ui.model.UiForm;
import ai.mindconnect.ui.model.UiNode;
import ai.mindconnect.ui.model.UiPatch;
import ai.mindconnect.ui.model.UiStack;
import ai.mindconnect.ui.model.UiTable;
import ai.mindconnect.ui.model.UiText;
import ai.mindconnect.ui.model.UiToast;
import ai.mindconnect.ui.model.UiTrigger;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.stream.Collectors;

/**
 * Everything it takes to run the agent server, as embeddable panels: status
 * with start/stop and the live log, the version catalog from Maven Central,
 * and the environment editor. The launcher hosts them as tabs; the chat
 * client embeds the same panels behind its "Manage server" view.
 *
 * <p>A server started by an earlier process is adopted through the pid file
 * and can be stopped here; closing the host app only stops a server this
 * panel itself started.
 */
public final class ServerControlPanel {

    /** What a postgres connection typically looks like — shown as placeholders, never saved. */
    private static final Map<String, String> POSTGRES_PLACEHOLDERS = Map.of(
            "MC_POSTGRES_URL", "jdbc:postgresql://localhost:5433/postgres",
            "MC_POSTGRES_USER", "postgres",
            "MC_POSTGRES_PASSWORD", "only with postgres");

    private final ServerHome home;
    private final ServerReleases releases;
    private final ServerProcess server;
    private final SuiFxEventBus bus;
    private final Consumer<String> linkOpener;

    private volatile ServerProcess.AdoptedServer adopted;
    /** The version Start is preparing (download, then launch); null when it is not. */
    private volatile String starting;
    /** True while Stop waits for the clean shutdown — the window in which Kill is offered. */
    private volatile boolean stopping;
    private volatile List<ServerReleases.ServerRelease> catalog = List.of();
    private volatile String lastStatus = "";
    private volatile String lastLog = "";
    /** False while the host does not have the panels in the mounted tree. */
    private volatile boolean mounted = true;

    public ServerControlPanel(SuiFxEventBus bus, ServerHome home,
                              ServerReleases releases, ServerProcess server,
                              Consumer<String> linkOpener) {
        this.bus = bus;
        this.home = home;
        this.releases = releases;
        this.server = server;
        this.linkOpener = linkOpener;
        this.adopted = ServerProcess.adopt(home).orElse(null);
    }

    // ── state the host can ask about ──────────────────────────────────────

    public boolean isRunning() {
        return server.isRunning() || adoptedAlive();
    }

    public boolean isReachable() {
        return ServerProcess.portInUse(port());
    }

    public int port() {
        if (server.isRunning()) return server.port();
        ServerProcess.AdoptedServer a = adopted;
        if (a != null && a.handle().isAlive()) return a.port();
        try {
            return Integer.parseInt(home.loadEnv().getOrDefault(ServerHome.SERVER_PORT, "9090"));
        } catch (NumberFormatException e) {
            return 9090;
        }
    }

    public String statusShort() {
        if (isReachable()) return "Running · port " + port();
        if (server.isRunning() || adoptedAlive()) return "Starting …";
        return "Stopped";
    }

    /** Stops only a server this panel started — an adopted one keeps running. */
    public void stopOwnServer() throws InterruptedException {
        server.stop();
    }

    private boolean adoptedAlive() {
        ServerProcess.AdoptedServer a = adopted;
        return a != null && a.handle().isAlive();
    }

    // ── panels ────────────────────────────────────────────────────────────

    public UiNode serverPanel() {
        return UiStack.of(statusText(), serverForm(), actionsRow(), logText());
    }

    public UiNode versionsPanel() {
        return UiStack.of(
                UiText.of("Releases from Maven Central, plus the development builds "
                        + "from the snapshot channels — main's first, then one per branch "
                        + "that has a build out. Download one, then activate it — the "
                        + "active version is what Start launches. A snapshot keeps its "
                        + "version while the build behind it moves on, so Download fetches "
                        + "it again."),
                versionsTable());
    }

    public UiNode environmentPanel() {
        Map<String, String> env = home.loadEnv();
        String extra = env.entrySet().stream()
                .filter(e -> !ServerHome.PROVIDER_KEYS.contains(e.getKey()))
                .filter(e -> !ServerHome.POSTGRES_KEYS.contains(e.getKey()))
                .filter(e -> !e.getKey().equals(ServerHome.PERSISTENCE))
                .filter(e -> !e.getKey().equals(ServerHome.ENCRYPTION_KEY))
                .filter(e -> !e.getKey().equals(ServerHome.ACTIVE_VERSION))
                .filter(e -> !e.getKey().equals(ServerHome.SERVER_PORT))
                .map(e -> e.getKey() + "=" + e.getValue())
                .collect(Collectors.joining("\n"));

        var form = UiForm.of("env-form", "Server environment")
                .field(encryptionKeyField(env.getOrDefault(ServerHome.ENCRYPTION_KEY, "")));
        for (String key : ServerHome.PROVIDER_KEYS) {
            form.field(UiField.text(key, key, env.getOrDefault(key, ""))
                    .asEditable().placeholder("optional"));
        }
        form.field(UiField.select(ServerHome.PERSISTENCE, "Persistence",
                        env.getOrDefault(ServerHome.PERSISTENCE, ServerHome.PERSISTENCE_MODES.get(0)),
                        ServerHome.PERSISTENCE_MODES.stream()
                                .map(mode -> UiField.Option.of(mode, mode)).toList())
                .asEditable()
                .hint("file keeps the data in the server home; postgres uses the connection below."));
        for (String key : ServerHome.POSTGRES_KEYS) {
            form.field(UiField.text(key, key, env.getOrDefault(key, ""))
                    .asEditable().placeholder(POSTGRES_PLACEHOLDERS.getOrDefault(key, "")));
        }
        form.content(UiField.textarea("extra", "Additional variables", extra)
                        .asEditable().hint("One KEY=VALUE per line."))
                .action(UiAction.primary("save-env", "Save")
                        .onClick(UiTrigger.invoke("saveEnvironment", "env-form")))
                .action(UiAction.secondary("gen-key", "Generate encryption key")
                        .onClick(UiTrigger.invoke("generateKey")));
        return form;
    }

    private UiNode statusText() {
        var text = UiText.of(statusLine());
        text.setId("server-status");
        return text;
    }

    private String statusLine() {
        if (stopping) return "◐ Stopping — waiting up to 15 s for a clean shutdown …";
        if (server.isRunning()) {
            return server.isReachable()
                    ? "● Running — version " + server.version() + " on port " + server.port()
                    : "◐ Starting — version " + server.version() + " on port " + server.port() + " …";
        }
        if (starting != null) return "◐ Preparing version " + starting + " …";
        ServerProcess.AdoptedServer a = adopted;
        if (a != null && a.handle().isAlive()) {
            return "● Running — pid " + a.pid() + ", port " + a.port()
                    + (a.isReachable() ? " (started earlier)" : " (not answering)");
        }
        if (ServerProcess.portInUse(port())) {
            return "● Something else answers on port " + port() + " — treating it as the server.";
        }
        return "○ Stopped";
    }

    private UiForm serverForm() {
        Map<String, String> env = home.loadEnv();
        return UiForm.of("server-form", null)
                .content(UiStack.of(
                                UiField.number("port", "Port",
                                        env.getOrDefault(ServerHome.SERVER_PORT, "9090")).asEditable(),
                                UiField.text("version", "Version", activeVersion(env))
                                        .hint("Change it under Versions."))
                        .direction(UiStack.Direction.HORIZONTAL)
                        .gap(16));
    }

    private UiNode actionsRow() {
        UiStack row;
        if (isRunning() || stopping) {
            // Kill is always in sight but only armed once Stop is on its way:
            // it skips the rest of the clean shutdown, nothing more.
            row = UiStack.of(
                    UiAction.primary("open-ui", "Open Admin UI")
                            .onClick(UiTrigger.invoke("openAdminUi")),
                    UiAction.danger("stop-server", "Stop")
                            .onClick(UiTrigger.invoke("stopServer"))
                            .enabledIf(!stopping, "Already stopping."),
                    UiAction.danger("kill-server", "Kill")
                            .onClick(UiTrigger.invoke("killServer"))
                            .enabledIf(stopping, "Press Stop first — Kill only cuts a stop short."));
        } else if (starting != null) {
            // No Start while one is under way — the status line says so.
            row = UiStack.of(
                    UiAction.secondary("show-log", "Show full log")
                            .onClick(UiTrigger.invoke("showLog")));
        } else {
            row = UiStack.of(
                    UiAction.primary("start-server", "Start")
                            .onClick(UiTrigger.invoke("startServer", "server-form")),
                    UiAction.secondary("show-log", "Show full log")
                            .onClick(UiTrigger.invoke("showLog")));
        }
        row.direction(UiStack.Direction.HORIZONTAL).gap(8);
        row.setId("server-actions");
        return row;
    }

    private UiNode logText() {
        String tail = server.tail(14);
        var text = UiText.of(tail.isBlank() ? "The server log appears here." : tail);
        text.setId("server-log");
        return text;
    }

    private UiTable versionsTable() {
        String active = activeVersion(home.loadEnv());
        var table = UiTable.of("versions-table", "Releases")
                .column(UiColumn.text("version", "Version"))
                .column(UiColumn.text("state", "State"))
                .column(UiColumn.text("source", "Source"))
                .action(UiAction.secondary("refresh-versions", "Refresh")
                        .onClick(UiTrigger.invoke("refreshVersions")))
                .rowAction(UiAction.secondary("download", "Download")
                        .onClick(UiTrigger.invoke("downloadVersion")))
                .rowAction(UiAction.primary("activate", "Activate")
                        .onClick(UiTrigger.invoke("activateVersion")));
        if (catalog.isEmpty()) {
            table.row(Map.of("version", "…", "state", "loading", "source", ""));
        } else {
            for (var release : catalog) {
                String state = release.version().equals(active) ? "active"
                        : releases.isInstalled(release.version()) ? "installed" : "—";
                // For a snapshot the build matters as much as the version: the
                // same version can sit on disk while a newer commit is out. The
                // branch says which channel it is — a branch build is opt-in.
                if (release.branch() != null) state += " · " + release.branch();
                if (release.detail() != null) state += " · " + release.detail();
                table.row(Map.of("version", release.version(), "state", state,
                        "source", release.source() == ServerReleases.Source.SNAPSHOT
                                ? "snapshot" : "central"));
            }
        }
        return table;
    }

    private UiField encryptionKeyField(String value) {
        return UiField.text(ServerHome.ENCRYPTION_KEY, "Encryption key", value)
                .asEditable()
                .hint("Encrypts stored LLM credentials — 32 characters. "
                        + "Generate one if you do not have one.");
    }

    // ── handlers ──────────────────────────────────────────────────────────

    public void installHandlers() {
        bus.registerClientHandler("startServer", ctx -> {
            if (isRunning()) {
                bus.toast(UiToast.info("The server is already running."));
                return;
            }
            if (starting != null) {
                bus.toast(UiToast.info("The server is already being started."));
                return;
            }
            Map<String, String> env = home.loadEnv();
            int port = parsePort(ctx.string("port"), env);
            if (ServerProcess.portInUse(port)) {
                int free = nextFreePort(port);
                bus.toast(UiToast.error("Port " + port + " is already in use — try " + free + ".")
                        .title("Cannot start"));
                return;
            }
            if (env.getOrDefault(ServerHome.ENCRYPTION_KEY, "").isBlank()) {
                env.put(ServerHome.ENCRYPTION_KEY, ServerHome.generateEncryptionKey());
                home.saveEnv(env);
                bus.toast(UiToast.info("No encryption key was set — generated one.")
                        .title("Environment"));
            }
            String version = activeVersion(env);
            // From here on it can take a while — a first Start downloads the
            // build — so the work moves to its own thread and the handler
            // returns at once. Otherwise the bus would keep the window behind
            // its spinner the whole time, although status line and log
            // already show what is happening.
            starting = version;
            refreshServerPanel();
            Thread thread = new Thread(() -> {
                try {
                    if (!releases.isInstalled(version)) {
                        installVersion(releaseFor(version));
                    }
                    env.put(ServerHome.SERVER_PORT, String.valueOf(port));
                    env.put(ServerHome.ACTIVE_VERSION, version);
                    home.saveEnv(env);
                    server.start(version, port, env);
                    bus.toast(UiToast.success("Version " + version + " on port " + port)
                            .title("Server starting"));
                } catch (Exception e) {
                    bus.toast(UiToast.error(String.valueOf(e.getMessage())).title("Start failed"));
                } finally {
                    starting = null;
                    refreshServerPanel();
                }
            }, "server-start");
            thread.setDaemon(true);
            thread.start();
        });

        bus.registerClientHandler("stopServer", ctx -> {
            if (stopping) return;
            // Same reason as Start: the wait can last 20 s, and the window
            // must stay usable meanwhile — that is where Kill lives.
            stopping = true;
            refreshServerPanel();
            Thread thread = new Thread(() -> {
                try {
                    if (server.isRunning()) {
                        server.stop();
                    } else if (adopted != null) {
                        adopted.stop();
                        adopted = null;
                    }
                    bus.toast(UiToast.success("Server stopped"));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    stopping = false;
                    refreshServerPanel();
                }
            }, "server-stop");
            thread.setDaemon(true);
            thread.start();
        });

        bus.registerClientHandler("killServer", ctx -> {
            try {
                if (server.isRunning()) {
                    server.kill();
                } else if (adopted != null) {
                    adopted.kill();
                    adopted = null;
                }
                bus.toast(UiToast.info("Server killed — no clean shutdown.").title("Server"));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            refreshServerPanel();
        });

        bus.registerClientHandler("openAdminUi", ctx ->
                linkOpener.accept("http://localhost:" + port()));

        bus.registerClientHandler("showLog", ctx ->
                bus.showDialog(UiDialog.of("Server log — " + home.logFile(), null,
                        UiText.of(server.tail(200).isBlank() ? "Nothing logged yet."
                                : server.tail(200)))));

        bus.registerClientHandler("refreshVersions", ctx -> refreshVersionsInBackground());

        bus.registerClientHandler("downloadVersion", ctx -> {
            String version = ctx.string("version");
            try {
                installVersion(releaseFor(version));
                bus.applyPatch(UiPatch.of()
                        .patch(UiPatch.Operation.replace("versions-table", versionsTable()))
                        .toast(UiToast.success("Version " + version + " is ready.")));
            } catch (Exception e) {
                bus.toast(UiToast.error(String.valueOf(e.getMessage())).title("Download failed"));
            }
        });

        bus.registerClientHandler("activateVersion", ctx -> {
            String version = ctx.string("version");
            Map<String, String> env = home.loadEnv();
            env.put(ServerHome.ACTIVE_VERSION, version);
            home.saveEnv(env);
            bus.applyPatch(UiPatch.of()
                    .patch(UiPatch.Operation.replace("versions-table", versionsTable()))
                    .patch(UiPatch.Operation.replace("server-form", serverForm()))
                    .toast(UiToast.success("Start now launches " + version + ".")
                            .title("Active version")));
        });

        bus.registerClientHandler("saveEnvironment", ctx -> {
            Map<String, String> env = home.loadEnv();
            putIfPresent(env, ServerHome.ENCRYPTION_KEY, ctx.string(ServerHome.ENCRYPTION_KEY));
            for (String key : ServerHome.PROVIDER_KEYS) {
                putIfPresent(env, key, ctx.string(key));
            }
            putIfPresent(env, ServerHome.PERSISTENCE, ctx.string(ServerHome.PERSISTENCE));
            for (String key : ServerHome.POSTGRES_KEYS) {
                putIfPresent(env, key, ctx.string(key));
            }
            String extra = ctx.string("extra");
            if (extra != null) {
                Map<String, String> keep = new LinkedHashMap<>();
                keep.put(ServerHome.ENCRYPTION_KEY, env.getOrDefault(ServerHome.ENCRYPTION_KEY, ""));
                keep.put(ServerHome.ACTIVE_VERSION, env.getOrDefault(ServerHome.ACTIVE_VERSION, ""));
                keep.put(ServerHome.SERVER_PORT, env.getOrDefault(ServerHome.SERVER_PORT, ""));
                for (String key : ServerHome.PROVIDER_KEYS) keep.put(key, env.getOrDefault(key, ""));
                keep.put(ServerHome.PERSISTENCE, env.getOrDefault(ServerHome.PERSISTENCE, ""));
                for (String key : ServerHome.POSTGRES_KEYS) keep.put(key, env.getOrDefault(key, ""));
                for (String line : extra.split("\n")) {
                    int eq = line.indexOf('=');
                    if (eq > 0) keep.put(line.substring(0, eq).trim(), line.substring(eq + 1).trim());
                }
                env = keep;
            }
            home.saveEnv(env);
            bus.toast(UiToast.success("Saved to " + home.envFile()).title("Environment"));
        });

        bus.registerClientHandler("generateKey", ctx -> {
            String key = ServerHome.generateEncryptionKey();
            Map<String, String> env = home.loadEnv();
            env.put(ServerHome.ENCRYPTION_KEY, key);
            home.saveEnv(env);
            bus.applyPatch(UiPatch.of()
                    .patch(UiPatch.Operation.replace(ServerHome.ENCRYPTION_KEY, encryptionKeyField(key)))
                    .toast(UiToast.success("New key generated and saved.").title("Encryption key")));
        });
    }

    /**
     * The build behind a version. Normally it comes from the catalog the
     * versions tab loaded; when that never ran — Start on a fresh launcher,
     * or an offline catalog — a Central release of that version is the
     * assumption, which is what the launcher did before there was a catalog.
     */
    private ServerReleases.ServerRelease releaseFor(String version) {
        return catalog.stream()
                .filter(r -> r.version().equals(version))
                .findFirst()
                .orElseGet(() -> new ServerReleases.ServerRelease(version,
                        ServerReleases.Source.CENTRAL,
                        "https://repo1.maven.org/maven2/" + ServerReleases.GROUP_PATH + "/"
                                + ServerReleases.APP + "/" + version + "/"
                                + ServerReleases.APP + "-" + version + "-exec.jar",
                        null, null));
    }

    /** Exec jar first; Maven classpath resolution as the honest fallback. */
    private void installVersion(ServerReleases.ServerRelease release) throws Exception {
        String version = release.version();
        server.appendLog("Downloading " + version + " from "
                + (release.source() != ServerReleases.Source.SNAPSHOT ? "Maven Central"
                        : release.branch() == null ? "the snapshot channel"
                        : "the snapshot channel of " + release.branch()) + " …");
        refreshLog();
        boolean gotExec = releases.downloadExecJar(release, percent -> {
            if (percent % 20 == 0) {
                server.appendLog("Download " + percent + "%");
                refreshLog();
            }
        });
        if (!gotExec) {
            server.appendLog("No executable jar published for " + version
                    + " — resolving the classpath with local Maven (first time only, ~1 min).");
            refreshLog();
            releases.resolveWithMaven(version, line -> {
                server.appendLog(line);
                refreshLog();
            });
        }
        server.appendLog("Version " + version + " is ready.");
        refreshLog();
    }

    // ── background refresh ────────────────────────────────────────────────

    public void refreshVersionsInBackground() {
        Thread thread = new Thread(() -> {
            try {
                catalog = releases.catalog();
                bus.applyPatch(UiPatch.of()
                        .patch(UiPatch.Operation.replace("versions-table", versionsTable())));
            } catch (Exception e) {
                bus.toast(UiToast.error(String.valueOf(e.getMessage()))
                        .title("Release list not reachable"));
            }
        }, "versions-refresh");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * Repaints status, actions and log when they change; {@code onStatusChange}
     * lets the host react too (the chat repaints its sidebar entry).
     */
    public void startPolling(Runnable onStatusChange) {
        Thread thread = new Thread(() -> {
            while (true) {
                try {
                    Thread.sleep(1000);
                    String status = statusLine();
                    String tail = server.tail(14);
                    if (!status.equals(lastStatus)) {
                        lastStatus = status;
                        refreshServerPanel();
                        if (onStatusChange != null) onStatusChange.run();
                    }
                    if (!tail.equals(lastLog)) {
                        lastLog = tail;
                        refreshLog();
                    }
                } catch (InterruptedException e) {
                    return;
                } catch (Exception ignored) {
                    // a failed repaint must not kill the poller
                }
            }
        }, "server-status-poller");
        thread.setDaemon(true);
        thread.start();
    }

    /** Hosts that show the panels on demand flip this to silence patches. */
    public void setMounted(boolean mounted) {
        this.mounted = mounted;
    }

    private void refreshServerPanel() {
        if (!mounted) return;
        bus.applyPatch(UiPatch.of()
                .patch(UiPatch.Operation.replace("server-status", statusText()))
                .patch(UiPatch.Operation.replace("server-actions", actionsRow())));
    }

    private void refreshLog() {
        if (!mounted) return;
        bus.applyPatch(UiPatch.of()
                .patch(UiPatch.Operation.replace("server-log", logText())));
    }

    // ── small helpers ─────────────────────────────────────────────────────

    /**
     * What Start launches when nothing is pinned: the newest RELEASE. The
     * snapshots head the catalog but are never the default — a development
     * build, and a branch build all the more, is something you choose, not
     * something you land on; a stale branch must never turn into "latest".
     */
    private String activeVersion(Map<String, String> env) {
        String pinned = env.get(ServerHome.ACTIVE_VERSION);
        if (pinned != null && !pinned.isBlank()) return pinned;
        return catalog.stream()
                .filter(r -> r.source() == ServerReleases.Source.CENTRAL)
                .map(ServerReleases.ServerRelease::version)
                .findFirst()
                .orElse("0.0.2");
    }

    private static int parsePort(String raw, Map<String, String> env) {
        try {
            if (raw != null && !raw.isBlank()) return (int) Double.parseDouble(raw);
        } catch (NumberFormatException ignored) {
            // fall through to the saved / default port
        }
        try {
            return Integer.parseInt(env.getOrDefault(ServerHome.SERVER_PORT, "9090"));
        } catch (NumberFormatException e) {
            return 9090;
        }
    }

    private static int nextFreePort(int from) {
        int candidate = from + 1;
        while (ServerProcess.portInUse(candidate)) candidate++;
        return candidate;
    }

    private static void putIfPresent(Map<String, String> env, String key, String value) {
        if (value == null) return;
        if (value.isBlank()) env.remove(key);
        else env.put(key, value.trim());
    }
}
