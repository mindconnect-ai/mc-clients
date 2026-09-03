package ai.mindconnect.agent.connector;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

/**
 * What the connector needs to bridge a home agent server to the Firebase
 * tunnel: which server id to claim, the Realtime Database URL, the path to
 * the service-account key, and where the local API listens.
 *
 * <p>Mirrors the environment variables the Node connector reads
 * ({@code SERVER_ID}, {@code RTDB_URL}, {@code FIREBASE_SERVICE_ACCOUNT},
 * {@code API_BASE}) so the two stay interchangeable. Persisted as a small
 * properties file the launcher can write from its settings panel.
 */
public record ConnectorConfig(String serverId, String rtdbUrl,
                              String serviceAccountPath, String apiBase) {

    public ConnectorConfig {
        serverId = serverId == null ? "" : serverId.trim();
        rtdbUrl = rtdbUrl == null ? "" : rtdbUrl.trim();
        serviceAccountPath = serviceAccountPath == null ? "" : serviceAccountPath.trim();
        apiBase = (apiBase == null || apiBase.isBlank()) ? "http://localhost:8080" : apiBase.trim();
    }

    /** Everything the tunnel actually needs is present. */
    public boolean isComplete() {
        return !serverId.isBlank() && !rtdbUrl.isBlank() && !serviceAccountPath.isBlank();
    }

    /** The first missing field, for a settings panel to point at — or null. */
    public String firstMissing() {
        if (serverId.isBlank()) return "serverId";
        if (rtdbUrl.isBlank()) return "rtdbUrl";
        if (serviceAccountPath.isBlank()) return "serviceAccountPath";
        return null;
    }

    // ── Persistence ──────────────────────────────────────────────────────

    public static ConnectorConfig load(Path file) {
        Properties p = new Properties();
        if (Files.exists(file)) {
            try (InputStream in = Files.newInputStream(file)) {
                p.load(in);
            } catch (IOException e) {
                // Unreadable config is treated as absent — the panel shows blanks.
            }
        }
        return new ConnectorConfig(
                p.getProperty("serverId"),
                p.getProperty("rtdbUrl"),
                p.getProperty("serviceAccountPath"),
                p.getProperty("apiBase"));
    }

    public void save(Path file) throws IOException {
        Properties p = new Properties();
        p.setProperty("serverId", serverId);
        p.setProperty("rtdbUrl", rtdbUrl);
        p.setProperty("serviceAccountPath", serviceAccountPath);
        p.setProperty("apiBase", apiBase);
        Files.createDirectories(file.getParent());
        try (OutputStream out = Files.newOutputStream(file)) {
            p.store(out, "mc-agent-remote-connector");
        }
    }

    /** Default location, alongside the launcher's own state:
     *  {@code ~/.mindconnect/admin-ui/connector.properties} (honours MC_HOME
     *  the same way the launcher's ServerHome does, so a wipe resets both). */
    public static Path defaultFile() {
        String override = System.getenv("MC_HOME");
        Path home = override != null && !override.isBlank()
                ? Path.of(override)
                : Path.of(System.getProperty("user.home"), ".mindconnect", "admin-ui");
        return home.resolve("connector.properties");
    }

    /** Where the push watcher persists its FCM tokens and per-session cursors,
     *  next to {@link #defaultFile()}. */
    public static Path defaultPushStateFile() {
        return defaultFile().resolveSibling("connector-push.properties");
    }
}
