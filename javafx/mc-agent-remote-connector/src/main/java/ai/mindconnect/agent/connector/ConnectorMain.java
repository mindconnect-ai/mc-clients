package ai.mindconnect.agent.connector;

import java.io.IOException;
import java.util.concurrent.CountDownLatch;

/**
 * Standalone entry point — parity with {@code node connector-rtdb.js}. Reads
 * config from the environment ({@code SERVER_ID}, {@code RTDB_URL},
 * {@code FIREBASE_SERVICE_ACCOUNT}, {@code API_BASE}), or falls back to the
 * saved {@link ConnectorConfig#defaultFile()}, then runs until Ctrl-C.
 *
 * <p>Inside the admin launcher the connector is driven by a UI panel instead;
 * this main is for headless runs and testing.
 */
public final class ConnectorMain {

    public static void main(String[] args) throws Exception {
        ConnectorConfig fromEnv = new ConnectorConfig(
                System.getenv("SERVER_ID"),
                System.getenv("RTDB_URL"),
                System.getenv("FIREBASE_SERVICE_ACCOUNT"),
                System.getenv("API_BASE"));
        // Environment wins; anything it leaves blank comes from the saved file.
        ConnectorConfig saved = ConnectorConfig.load(ConnectorConfig.defaultFile());
        ConnectorConfig config = new ConnectorConfig(
                orElse(fromEnv.serverId(), saved.serverId()),
                orElse(fromEnv.rtdbUrl(), saved.rtdbUrl()),
                orElse(fromEnv.serviceAccountPath(), saved.serviceAccountPath()),
                orElse(blankToNull(System.getenv("API_BASE")), saved.apiBase()));

        if (!config.isComplete()) {
            System.err.println("configuration incomplete: missing " + config.firstMissing());
            System.err.println("set SERVER_ID, RTDB_URL and FIREBASE_SERVICE_ACCOUNT "
                    + "(and optionally API_BASE), or save " + ConnectorConfig.defaultFile());
            System.exit(1);
        }

        RemoteConnector connector = new RemoteConnector(config, System.out::println, null);
        CountDownLatch stopped = new CountDownLatch(1);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            connector.stop();
            stopped.countDown();
        }));
        try {
            connector.start();
        } catch (IOException e) {
            System.err.println("connector failed to start: " + e.getMessage());
            System.exit(1);
        }
        stopped.await(); // block until the shutdown hook fires
    }

    private static String orElse(String a, String b) {
        return a != null && !a.isBlank() ? a : b;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private ConnectorMain() { }
}
