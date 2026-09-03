package ai.mindconnect.agent.adminlauncher;

import ai.mindconnect.agent.connector.ConnectorConfig;
import ai.mindconnect.agent.connector.RemoteConnector;
import ai.mindconnect.ui.javafx.FxTriggerContext;
import ai.mindconnect.ui.javafx.SuiFxEventBus;
import ai.mindconnect.ui.model.UiAction;
import ai.mindconnect.ui.model.UiField;
import ai.mindconnect.ui.model.UiForm;
import ai.mindconnect.ui.model.UiNode;
import ai.mindconnect.ui.model.UiPatch;
import ai.mindconnect.ui.model.UiStack;
import ai.mindconnect.ui.model.UiText;
import ai.mindconnect.ui.model.UiToast;
import ai.mindconnect.ui.model.UiTrigger;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.function.IntSupplier;

/**
 * The mobile relay's home end, as a launcher tab: configure the Firebase
 * connector, start and stop it, watch its log. The connector runs
 * in-process on a background thread — it lives while the launcher is open,
 * the same way {@link ServerControlPanel} owns the server it starts.
 *
 * <p>Built from the same Semantic UI vocabulary as the server panel, so it
 * drops into {@code LauncherApp.ui()} as another {@link ai.mindconnect.ui.model.UiSection}.
 */
public final class ConnectorPanel {

    private static final int LOG_LINES = 200;

    private final SuiFxEventBus bus;
    private final Path configFile;
    private final IntSupplier serverPort;

    private final Deque<String> log = new ArrayDeque<>();
    private volatile ConnectorConfig config;
    private volatile RemoteConnector connector;
    private volatile RemoteConnector.State state = RemoteConnector.State.STOPPED;
    private volatile boolean mounted = true;
    private volatile String lastStatus = "";
    private volatile String lastLog = "";

    /**
     * @param serverPort the agent server's current port, to prefill the local
     *                   API base — the connector usually talks to that server.
     */
    public ConnectorPanel(SuiFxEventBus bus, Path configFile, IntSupplier serverPort) {
        this.bus = bus;
        this.configFile = configFile;
        this.serverPort = serverPort;
        this.config = ConnectorConfig.load(configFile);
    }

    /** The local API base always follows the launcher's own server — so the
     *  field never needs tending. Falls back to the saved value when no port
     *  supplier is wired (e.g. a headless embedding). */
    private String currentApiBase() {
        if (serverPort != null) return "http://localhost:" + serverPort.getAsInt();
        return config.apiBase();
    }

    // ── panel ────────────────────────────────────────────────────────────

    public UiNode panel() {
        return UiStack.of(statusText(), configForm(), actionsRow(), logText());
    }

    private UiNode statusText() {
        UiText text = UiText.of(statusLine());
        text.setId("connector-status");
        return text;
    }

    private String statusLine() {
        return switch (state) {
            case RUNNING -> "● Connected — " + config.serverId() + " → Firebase (api " + config.apiBase() + ")";
            case STARTING -> "◐ Connecting …";
            case FAILED -> "✗ Failed — see the log below";
            case STOPPED -> "○ Stopped";
        };
    }

    private UiForm configForm() {
        return UiForm.of("connector-form", "Connector configuration")
                .field(UiField.text("serverId", "Server ID", config.serverId())
                        .asEditable().placeholder("home-1")
                        .hint("Any stable name; the phone talks to this id."))
                .field(UiField.text("rtdbUrl", "Realtime Database URL", config.rtdbUrl())
                        .asEditable()
                        .placeholder("https://<project>-default-rtdb.<region>.firebasedatabase.app"))
                .field(UiField.text("serviceAccountPath", "Service-account JSON", config.serviceAccountPath())
                        .asEditable().placeholder("/path/to/service-account.json")
                        .hint("Firebase console → Project settings → Service accounts → Generate key."))
                // Read-only: it follows the launcher's server port automatically.
                .field(UiField.text("apiBase", "Local API base", currentApiBase())
                        .hint("Follows the launcher's server port automatically."))
                .action(UiAction.primary("save-connector", "Save")
                        .onClick(UiTrigger.invoke("saveConnector", "connector-form")));
    }

    private UiNode actionsRow() {
        UiStack row = running()
                ? UiStack.of(UiAction.danger("stop-connector", "Stop")
                        .onClick(UiTrigger.invoke("stopConnector")))
                : UiStack.of(UiAction.primary("start-connector", "Start")
                        .onClick(UiTrigger.invoke("startConnector", "connector-form")));
        row.direction(UiStack.Direction.HORIZONTAL).gap(8);
        row.setId("connector-actions");
        return row;
    }

    private UiNode logText() {
        UiText text = UiText.of(logTail());
        text.setId("connector-log");
        return text;
    }

    // ── handlers ─────────────────────────────────────────────────────────

    public void installHandlers() {
        bus.registerClientHandler("saveConnector", ctx -> {
            config = fromForm(ctx);
            try {
                config.save(configFile);
                bus.toast(UiToast.success("Saved to " + configFile).title("Connector"));
            } catch (IOException e) {
                bus.toast(UiToast.error(String.valueOf(e.getMessage())).title("Save failed"));
            }
        });

        bus.registerClientHandler("startConnector", ctx -> {
            if (running()) {
                bus.toast(UiToast.info("The connector is already running."));
                return;
            }
            config = fromForm(ctx);
            try {
                config.save(configFile);
            } catch (IOException e) {
                bus.toast(UiToast.error(String.valueOf(e.getMessage())).title("Save failed"));
                return;
            }
            if (!config.isComplete()) {
                bus.toast(UiToast.error("Fill in " + config.firstMissing() + " first.")
                        .title("Cannot start"));
                return;
            }
            startConnector();
        });

        bus.registerClientHandler("stopConnector", ctx -> stopConnector());
    }

    private void startConnector() {
        appendLog("starting …");
        RemoteConnector rc = new RemoteConnector(config, this::appendLog, s -> state = s);
        connector = rc;
        // start() blocks on the first Firebase round-trip — keep it off the UI.
        Thread t = new Thread(() -> {
            try {
                rc.start();
                bus.toast(UiToast.success(config.serverId() + " → Firebase").title("Connector up"));
            } catch (IOException | RuntimeException e) {
                appendLog("start failed: " + e.getMessage());
                bus.toast(UiToast.error(String.valueOf(e.getMessage())).title("Start failed"));
            }
            refreshStatus();
        }, "connector-start");
        t.setDaemon(true);
        t.start();
    }

    private void stopConnector() {
        RemoteConnector rc = connector;
        if (rc == null) return;
        Thread t = new Thread(() -> {
            rc.stop();
            connector = null;
            appendLog("stopped");
            bus.toast(UiToast.success("Connector stopped"));
            refreshStatus();
        }, "connector-stop");
        t.setDaemon(true);
        t.start();
    }

    /** Called by the host when the window closes — a background connector dies
     *  with the launcher, matching how an own-started server is stopped. */
    public void stopIfRunning() {
        RemoteConnector rc = connector;
        if (rc != null) rc.stop();
    }

    public boolean running() {
        return state == RemoteConnector.State.RUNNING || state == RemoteConnector.State.STARTING;
    }

    // ── polling / repaint ────────────────────────────────────────────────

    public void startPolling() {
        Thread t = new Thread(() -> {
            while (true) {
                try {
                    Thread.sleep(1000);
                    String status = statusLine();
                    String tail = logTail();
                    if (!status.equals(lastStatus)) {
                        lastStatus = status;
                        refreshStatus();
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
        }, "connector-poller");
        t.setDaemon(true);
        t.start();
    }

    public void setMounted(boolean mounted) {
        this.mounted = mounted;
    }

    private void refreshStatus() {
        if (!mounted) return;
        bus.applyPatch(UiPatch.of()
                .patch(UiPatch.Operation.replace("connector-status", statusText()))
                .patch(UiPatch.Operation.replace("connector-actions", actionsRow())));
    }

    private void refreshLog() {
        if (!mounted) return;
        bus.applyPatch(UiPatch.of()
                .patch(UiPatch.Operation.replace("connector-log", logText())));
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private ConnectorConfig fromForm(FxTriggerContext ctx) {
        // apiBase is not taken from the form — it always follows the launcher.
        return new ConnectorConfig(
                ctx.string("serverId"),
                ctx.string("rtdbUrl"),
                ctx.string("serviceAccountPath"),
                currentApiBase());
    }

    private synchronized void appendLog(String line) {
        log.addLast(line);
        while (log.size() > LOG_LINES) log.removeFirst();
    }

    private synchronized String logTail() {
        if (log.isEmpty()) return "The connector log appears here.";
        return String.join("\n", log);
    }
}
