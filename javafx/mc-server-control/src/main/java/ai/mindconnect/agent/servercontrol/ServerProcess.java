package ai.mindconnect.agent.servercontrol;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;

/**
 * The running server as the launcher sees it: one child JVM, its captured
 * output, and a TCP view on the port. Stopping is a normal destroy first
 * (Spring Boot shuts down cleanly on SIGTERM) with a forceful fallback.
 */
public final class ServerProcess {

    private static final int LOG_LINES = 400;

    private final ServerHome home;
    private final ServerReleases repository;
    private final Deque<String> log = new ArrayDeque<>();

    private volatile Process process;
    private volatile int port;
    private volatile String version;

    public ServerProcess(ServerHome home, ServerReleases repository) {
        this.home = home;
        this.repository = repository;
    }

    public synchronized void start(String version, int port, Map<String, String> env)
            throws IOException {
        if (isRunning()) throw new IllegalStateException("The server is already running.");

        List<String> command = new ArrayList<>();
        command.add(javaBinary());
        if (Files.exists(repository.execJar(version))) {
            command.add("-jar");
            command.add(repository.execJar(version).toString());
        } else if (Files.isDirectory(repository.libDir(version))) {
            command.add("-cp");
            command.add(repository.libDir(version) + java.io.File.separator + "*");
            command.add(ServerReleases.MAIN_CLASS);
        } else {
            throw new IOException("Version " + version + " is not installed yet.");
        }

        ProcessBuilder builder = new ProcessBuilder(command)
                .directory(home.dir().toFile())
                .redirectErrorStream(true);
        builder.environment().putAll(env);
        builder.environment().put(ServerHome.SERVER_PORT, String.valueOf(port));

        Files.createDirectories(home.logFile().getParent());
        synchronized (log) {
            log.clear();
        }
        this.port = port;
        this.version = version;
        this.process = builder.start();
        writePidFile(home, process, port, version);

        Thread gobbler = new Thread(() -> {
            try (var reader = process.inputReader();
                 var writer = Files.newBufferedWriter(home.logFile(),
                         java.nio.file.StandardOpenOption.CREATE,
                         java.nio.file.StandardOpenOption.APPEND)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    writer.write(line);
                    writer.newLine();
                    writer.flush();
                    synchronized (log) {
                        log.addLast(line);
                        while (log.size() > LOG_LINES) log.removeFirst();
                    }
                }
            } catch (IOException ignored) {
                // stream closes when the process dies — that is the exit condition
            }
        }, "server-log-gobbler");
        gobbler.setDaemon(true);
        gobbler.start();
    }

    /**
     * The normal stop: SIGTERM, and SIGKILL after 15 seconds if the clean
     * shutdown does not finish. Deliberately not synchronized while waiting,
     * so {@link #kill()} can cut the wait short from another thread.
     */
    public void stop() throws InterruptedException {
        Process p = process;
        if (p == null) return;
        p.destroy();
        if (!p.waitFor(15, java.util.concurrent.TimeUnit.SECONDS)) {
            p.destroyForcibly();
            p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
        }
        finish(p);
    }

    /**
     * The impatient stop: SIGKILL right away, no clean shutdown. A
     * {@link #stop()} still waiting on the same process sees it exit and
     * returns.
     */
    public void kill() throws InterruptedException {
        Process p = process;
        if (p == null) return;
        p.destroyForcibly();
        p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
        finish(p);
    }

    /** Bookkeeping after an exit — once, whichever of stop and kill gets there first. */
    private synchronized void finish(Process p) {
        if (process != p) return;
        process = null;
        deletePidFile(home);
    }

    // ── pid file: recognise and stop a server this JVM did not start ──────

    /** A server found via the pid file — started by an earlier launcher run. */
    public record AdoptedServer(long pid, int port, String version, ProcessHandle handle) {

        public boolean isReachable() {
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", port), 300);
                return true;
            } catch (IOException e) {
                return false;
            }
        }

        /** Same semantics as a normal stop: SIGTERM, forceful after a wait. */
        public void stop() throws InterruptedException {
            handle.destroy();
            if (!waitForExit(15)) {
                handle.destroyForcibly();
                waitForExit(5);
            }
        }

        /** SIGKILL right away; a waiting {@link #stop()} sees the exit and returns. */
        public void kill() throws InterruptedException {
            handle.destroyForcibly();
            waitForExit(5);
        }

        private boolean waitForExit(int seconds) throws InterruptedException {
            for (int i = 0; i < seconds * 10 && handle.isAlive(); i++) Thread.sleep(100);
            return !handle.isAlive();
        }
    }

    /**
     * Reads the pid file and validates it against the live process table.
     * PID alone is not identity — the OS reuses them — so the recorded start
     * instant must match too (±2s). A stale file is deleted on the spot.
     */
    public static java.util.Optional<AdoptedServer> adopt(ServerHome home) {
        Path file = pidFile(home);
        if (!Files.exists(file)) return java.util.Optional.empty();
        try {
            var props = new java.util.Properties();
            try (var in = Files.newInputStream(file)) {
                props.load(in);
            }
            long pid = Long.parseLong(props.getProperty("pid", "-1"));
            int port = Integer.parseInt(props.getProperty("port", "-1"));
            long started = Long.parseLong(props.getProperty("started", "-1"));
            String version = props.getProperty("version", "?");

            var handle = ProcessHandle.of(pid).orElse(null);
            if (handle == null || !handle.isAlive()) {
                Files.deleteIfExists(file);
                return java.util.Optional.empty();
            }
            long actualStart = handle.info().startInstant()
                    .map(java.time.Instant::toEpochMilli).orElse(-1L);
            if (actualStart > 0 && Math.abs(actualStart - started) > 2000) {
                // pid reused by an unrelated process — not our server
                Files.deleteIfExists(file);
                return java.util.Optional.empty();
            }
            return java.util.Optional.of(new AdoptedServer(pid, port, version, handle));
        } catch (Exception e) {
            return java.util.Optional.empty();
        }
    }

    private static void writePidFile(ServerHome home, Process process, int port, String version) {
        try {
            long started = process.toHandle().info().startInstant()
                    .map(java.time.Instant::toEpochMilli).orElse(System.currentTimeMillis());
            Files.writeString(pidFile(home),
                    "pid=" + process.pid() + "\nport=" + port
                            + "\nversion=" + version + "\nstarted=" + started + "\n");
        } catch (IOException ignored) {
            // adoption is a convenience; starting must not fail on it
        }
    }

    private static void deletePidFile(ServerHome home) {
        try {
            Files.deleteIfExists(pidFile(home));
        } catch (IOException ignored) {
            // stale file is cleaned up by the next adopt()
        }
    }

    public static Path pidFile(ServerHome home) {
        return home.dir().resolve("server.pid");
    }

    public boolean isRunning() {
        Process p = process;
        return p != null && p.isAlive();
    }

    /** True once something accepts connections on the server's port. */
    public boolean isReachable() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", port), 300);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** True when the port is taken before we start — by anything. */
    public static boolean portInUse(int port) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", port), 300);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    public int port() {
        return port;
    }

    public String version() {
        return version;
    }

    public String tail(int lines) {
        synchronized (log) {
            return log.stream().skip(Math.max(0, log.size() - lines))
                    .reduce((a, b) -> a + "\n" + b).orElse("");
        }
    }

    public void appendLog(String line) {
        synchronized (log) {
            log.addLast(line);
            while (log.size() > LOG_LINES) log.removeFirst();
        }
    }

    /**
     * The JVM to start the server with. First choice is our own runtime
     * ({@code java.home}) — in a jpackage build that is the bundled one, so
     * the packaged launcher needs no Java on the machine at all. The
     * fallbacks matter because a double-clicked GUI app does not see the
     * user's shell PATH.
     */
    private static String javaBinary() throws IOException {
        boolean windows = System.getProperty("os.name", "").toLowerCase().contains("win");
        String exe = windows ? "java.exe" : "java";

        Path own = Path.of(System.getProperty("java.home"), "bin", exe);
        if (Files.isExecutable(own)) return own.toString();

        String javaHome = System.getenv("JAVA_HOME");
        if (javaHome != null && !javaHome.isBlank()) {
            Path fromEnv = Path.of(javaHome, "bin", exe);
            if (Files.isExecutable(fromEnv)) return fromEnv.toString();
        }

        // macOS: ask the system for a registered JDK instead of trusting the
        // /usr/bin/java stub, which pops a "Missing Java runtime" dialog.
        Path javaHomeTool = Path.of("/usr/libexec/java_home");
        if (Files.isExecutable(javaHomeTool)) {
            try {
                Process probe = new ProcessBuilder(javaHomeTool.toString()).start();
                String found = new String(probe.getInputStream().readAllBytes()).trim();
                if (probe.waitFor() == 0 && !found.isBlank()) {
                    Path fromTool = Path.of(found, "bin", exe);
                    if (Files.isExecutable(fromTool)) return fromTool.toString();
                }
            } catch (Exception ignored) {
                // fall through to the PATH lookup
            }
        }

        String pathVar = System.getenv("PATH");
        if (pathVar != null) {
            for (String entry : pathVar.split(java.io.File.pathSeparator)) {
                Path candidate = Path.of(entry).resolve(exe);
                if (Files.isExecutable(candidate)) return candidate.toString();
            }
        }
        throw new IOException("No Java runtime found to start the server. "
                + "Install Java 21+ or set JAVA_HOME.");
    }
}
