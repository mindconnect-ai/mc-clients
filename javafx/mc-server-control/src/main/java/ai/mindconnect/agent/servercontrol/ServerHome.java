package ai.mindconnect.agent.servercontrol;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The launcher's home directory — the same one the shell scripts use
 * ({@code ~/.mindconnect/admin-ui}), so both ways of running the server share
 * jars, settings, data and logs. Settings live in {@code app.env}, one
 * {@code KEY=VALUE} per line.
 */
public final class ServerHome {

    /** The env key whose value the server requires to encrypt stored credentials. */
    public static final String ENCRYPTION_KEY = "MINDCONNECT_ENCRYPTION_SECRET_KEY";
    /** The env key the launcher itself uses to remember the active server version. */
    public static final String ACTIVE_VERSION = "MC_VERSION";
    /** The env key the launcher itself uses to remember the chosen port. */
    public static final String SERVER_PORT = "SERVER_PORT";

    /** Provider keys shown as named fields; everything else lands in "additional". */
    public static final List<String> PROVIDER_KEYS = List.of(
            "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "TAVILY_API_KEY");

    private final Path dir;

    public ServerHome() {
        String override = System.getenv("MC_HOME");
        this.dir = override != null && !override.isBlank()
                ? Path.of(override)
                : Path.of(System.getProperty("user.home"), ".mindconnect", "admin-ui");
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public Path dir() {
        return dir;
    }

    public Path envFile() {
        return dir.resolve("app.env");
    }

    public Path logFile() {
        return dir.resolve("logs").resolve("launcher-server.log");
    }

    /** Reads {@code app.env}; missing file is an empty map. Order is preserved. */
    public Map<String, String> loadEnv() {
        Map<String, String> env = new LinkedHashMap<>();
        Path file = envFile();
        if (!Files.exists(file)) return env;
        try {
            for (String line : Files.readAllLines(file)) {
                String trimmed = line.trim();
                if (trimmed.isEmpty() || trimmed.startsWith("#")) continue;
                int eq = trimmed.indexOf('=');
                if (eq <= 0) continue;
                env.put(trimmed.substring(0, eq).trim(), trimmed.substring(eq + 1).trim());
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return env;
    }

    /** Writes the full settings map back to {@code app.env}. */
    public void saveEnv(Map<String, String> env) {
        List<String> lines = new ArrayList<>();
        env.forEach((k, v) -> {
            if (k != null && !k.isBlank() && v != null && !v.isBlank()) lines.add(k + "=" + v);
        });
        try {
            Files.createDirectories(envFile().getParent());
            Files.write(envFile(), lines);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** 32 hex characters from a crypto-strength source. */
    public static String generateEncryptionKey() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
