package ai.mindconnect.agent.connector;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.BatchResponse;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.MulticastMessage;
import com.google.firebase.messaging.Notification;
import com.google.firebase.messaging.SendResponse;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * Standing attaches → push. The Java port of {@code relay/connector/push.js}:
 * watches session streams on the local API and turns
 * {@code approval_requested} / {@code done} / {@code error} frames into FCM
 * notifications, so the phone rings when an agent is waiting even with the app
 * closed. Without a usable {@link FirebaseMessaging} or any registered token it
 * degrades to log lines.
 *
 * <p>The connector's {@code /relay/push/**} control routes drive it; the phone
 * calls them through the tunnel to register its token and watch a session.
 */
public final class PushWatcher {

    private static final long RETRY_MS = 3_000;

    private final String apiBase;
    private final Path stateFile;
    private final Consumer<String> log;
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();

    private final List<String> fcmTokens = new CopyOnWriteArrayList<>();
    private final Map<String, Long> sessions = new ConcurrentHashMap<>(); // id → last seen seq
    private final Map<String, Thread> loops = new ConcurrentHashMap<>();

    private volatile FirebaseMessaging messaging;
    private volatile boolean running;

    public PushWatcher(String apiBase, Path stateFile, Consumer<String> log) {
        this.apiBase = apiBase;
        this.stateFile = stateFile;
        this.log = log != null ? log : m -> { };
        loadState();
    }

    // ── lifecycle ────────────────────────────────────────────────────────

    public void start(FirebaseApp app) {
        try {
            this.messaging = FirebaseMessaging.getInstance(app);
            log.accept("push: FCM ready");
        } catch (RuntimeException e) {
            log.accept("push: FCM unavailable, notifications go to the log — " + e.getMessage());
        }
        running = true;
        for (String sessionId : sessions.keySet()) startLoop(sessionId);
    }

    public void stop() {
        running = false;
        loops.values().forEach(Thread::interrupt);
        loops.clear();
    }

    // ── control surface (called from the tunnel's /relay/push/** routes) ──

    /** @return the JSON response body, or null for an unknown push route. */
    public String control(String route, String body) throws IOException {
        JsonNode n = (body == null || body.isBlank())
                ? mapper.createObjectNode() : mapper.readTree(body);
        switch (route) {
            case "/relay/push/token" -> registerToken(text(n, "fcmToken"));
            case "/relay/push/watch" -> watch(text(n, "sessionId"), text(n, "fcmToken"));
            case "/relay/push/unwatch" -> unwatch(text(n, "sessionId"));
            default -> {
                return null;
            }
        }
        return "{\"ok\":true}";
    }

    public void registerToken(String token) {
        if (token != null && !token.isBlank() && !fcmTokens.contains(token)) {
            fcmTokens.add(token);
            saveState();
        }
    }

    public void watch(String sessionId, String token) {
        if (sessionId == null || sessionId.isBlank()) return;
        registerToken(token);
        if (sessions.putIfAbsent(sessionId, 0L) == null) saveState();
        startLoop(sessionId);
    }

    public void unwatch(String sessionId) {
        if (sessionId == null) return;
        sessions.remove(sessionId);
        saveState();
        Thread loop = loops.remove(sessionId);
        if (loop != null) loop.interrupt();
    }

    // ── reattach loops ───────────────────────────────────────────────────

    private void startLoop(String sessionId) {
        loops.computeIfAbsent(sessionId, id -> {
            Thread t = new Thread(() -> runLoop(id), "push-watch-" + id);
            t.setDaemon(true);
            t.start();
            return t;
        });
    }

    private void runLoop(String sessionId) {
        while (running && sessions.containsKey(sessionId) && !Thread.currentThread().isInterrupted()) {
            try {
                attachOnce(sessionId);
            } catch (IOException e) {
                if (!running) break;
                String msg = e.getMessage() != null ? e.getMessage() : e.toString();
                log.accept("push: stream " + sessionId + " — " + msg);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            try {
                Thread.sleep(RETRY_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        loops.remove(sessionId);
    }

    /** Attach after the last seen seq, read until the server's SSE emitter
     *  times out (~120 s), then the loop attaches again. */
    private void attachOnce(String sessionId) throws IOException, InterruptedException {
        long afterSeq = sessions.getOrDefault(sessionId, 0L);
        HttpRequest request = HttpRequest.newBuilder(URI.create(
                        apiBase + "/api/sessions/" + sessionId + "/stream?afterSeq=" + afterSeq))
                .header("accept", "text/event-stream")
                .build();
        HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() == 404) {
            // Session gone (or a server from before the stream endpoint) — stop watching.
            response.body().close();
            unwatch(sessionId);
            return;
        }
        if (response.statusCode() / 100 != 2) {
            response.body().close();
            throw new IOException("server answered " + response.statusCode());
        }
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("data:")) onFrame(sessionId, mapper.readTree(line.substring(5).trim()));
            }
        }
    }

    private void onFrame(String sessionId, JsonNode node) {
        if ("attached".equals(node.path("type").asText())) return;
        if (node.hasNonNull("seq")) {
            sessions.put(sessionId, node.path("seq").asLong());
            saveState();
        }
        JsonNode event = node.path("event");
        String type = event.path("type").asText("");
        switch (type) {
            case "approval_requested" -> notify("Agent wartet auf Freigabe",
                    (event.path("toolName").asText("Ein Tool")) + " möchte ausgeführt werden.", sessionId);
            case "done" -> notify("Turn fertig",
                    trim(event.path("finalText").asText("")), sessionId);
            case "error" -> notify("Turn fehlgeschlagen",
                    event.path("error").asText(""), sessionId);
            default -> { }
        }
    }

    private void notify(String title, String body, String sessionId) {
        if (messaging == null || fcmTokens.isEmpty()) {
            log.accept("push [" + sessionId + "]: " + title + " — " + body);
            return;
        }
        try {
            MulticastMessage message = MulticastMessage.builder()
                    .addAllTokens(fcmTokens)
                    .setNotification(Notification.builder().setTitle(title).setBody(body).build())
                    .putData("sessionId", sessionId)
                    .build();
            BatchResponse response = messaging.sendEachForMulticast(message);
            // Drop tokens FCM no longer knows, so dead installs stop accumulating.
            List<String> dead = new ArrayList<>();
            List<SendResponse> responses = response.getResponses();
            for (int i = 0; i < responses.size(); i++) {
                SendResponse r = responses.get(i);
                if (r.getException() != null && r.getException().getMessagingErrorCode() != null
                        && "UNREGISTERED".equals(r.getException().getMessagingErrorCode().name())) {
                    dead.add(fcmTokens.get(i));
                }
            }
            if (!dead.isEmpty()) {
                fcmTokens.removeAll(dead);
                saveState();
            }
        } catch (Exception e) {
            log.accept("push: send failed — " + e.getMessage());
        }
    }

    // ── state persistence ────────────────────────────────────────────────
    // A tiny properties file: the token list joined by commas, one line per
    // watched session's cursor. Keeps the module free of a JSON-on-disk format.

    private void loadState() {
        if (!Files.exists(stateFile)) return;
        Properties p = new Properties();
        try (InputStream in = Files.newInputStream(stateFile)) {
            p.load(in);
        } catch (IOException e) {
            return;
        }
        String tokens = p.getProperty("fcmTokens", "");
        for (String t : tokens.split(",")) {
            if (!t.isBlank()) fcmTokens.add(t.trim());
        }
        for (String name : p.stringPropertyNames()) {
            if (name.startsWith("session.")) {
                try {
                    sessions.put(name.substring("session.".length()),
                            Long.parseLong(p.getProperty(name)));
                } catch (NumberFormatException ignored) {
                    // skip a corrupt cursor line
                }
            }
        }
    }

    private synchronized void saveState() {
        Properties p = new Properties();
        p.setProperty("fcmTokens", String.join(",", fcmTokens));
        for (Map.Entry<String, Long> e : sessions.entrySet()) {
            p.setProperty("session." + e.getKey(), String.valueOf(e.getValue()));
        }
        try {
            if (stateFile.getParent() != null) Files.createDirectories(stateFile.getParent());
            try (var out = Files.newOutputStream(stateFile)) {
                p.store(out, "mc-agent-remote-connector push state");
            }
        } catch (IOException e) {
            log.accept("push: could not save state — " + e.getMessage());
        }
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    private static String trim(String s) {
        return s != null && s.length() > 120 ? s.substring(0, 120) : s;
    }
}
