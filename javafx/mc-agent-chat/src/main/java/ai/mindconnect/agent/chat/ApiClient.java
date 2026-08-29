package ai.mindconnect.agent.chat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * The slice of the server's REST API ({@code /api/**}) an end-user chat
 * needs: agents, sessions, history, the SSE chat stream, the approval
 * questions a parked tool is waiting on, and the session stream to reattach
 * to a turn that is already running. Message bodies and frames are the wire
 * JSON, mapped to small records here.
 *
 * <p>The last two arrived with the snapshot builds; against an older server
 * {@link #attach} reports that it is not there and the chat carries on
 * without reattaching.
 */
public final class ApiClient {

    public record Agent(String id, String name, String description, String welcomeMessage) {}

    public record Session(String id, String title, String startedAt) {}

    public record HistoryMessage(String senderType, String content) {}

    /** A transcript entry: a chat bubble, or the tools a turn used. */
    public record HistoryEntry(String senderType, String type, String content,
                               List<String> toolNames) {}

    /**
     * One SSE frame of a running turn — only the fields the chat shows.
     *
     * <p>On an {@code approval_requested} frame the server puts the call id in
     * {@code text}: the frame record has no component of its own for it, and
     * the id is what answering the question needs.
     */
    public record Frame(String type, String text, String toolName, String agentName,
                        String finalText, String error, Long durationMs,
                        String argsJson, Frame inner) {}

    /** An open approval question: a tool call parked until a human decides. */
    public record Approval(String callId, String toolName, String argsJson) {}

    /**
     * The first frame of a session stream. {@code liveTurnId} is null when the
     * session is idle; a {@code firstBufferedSeq} beyond the requested
     * {@code afterSeq + 1} means events were evicted before we came back.
     */
    public record Attached(long firstBufferedSeq, long latestSeq,
                           String liveTurnId, Integer liveRun) {}

    /** One event of a session stream, with the cursor and the turn it belongs to. */
    public record StreamFrame(long seq, String turnId, int run, Frame event) {}

    private static final String NAMESPACE = "local";

    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();
    private final String base;
    private final String userId;

    public ApiClient(String base, String userId) {
        this.base = base;
        this.userId = userId;
    }

    public String base() {
        return base;
    }

    public List<Agent> listAgents() throws IOException, InterruptedException {
        JsonNode agents = getJson("/api/agents?namespace=" + NAMESPACE);
        List<Agent> result = new ArrayList<>();
        for (JsonNode a : agents) {
            if (!"ACTIVE".equals(a.path("status").asText("ACTIVE"))) continue;
            result.add(new Agent(a.path("id").asText(), a.path("name").asText(),
                    a.path("description").asText(""),
                    a.path("welcomeMessage").isNull() ? null : a.path("welcomeMessage").asText()));
        }
        result.sort((x, y) -> x.name().compareToIgnoreCase(y.name()));
        return result;
    }

    public List<Session> listSessions(String agentId) throws IOException, InterruptedException {
        JsonNode sessions = getJson("/api/sessions?namespace=" + NAMESPACE
                + "&userId=" + URLEncoder.encode(userId, StandardCharsets.UTF_8)
                + "&agentId=" + agentId);
        List<Session> result = new ArrayList<>();
        for (JsonNode s : sessions) {
            if (!"ACTIVE".equals(s.path("status").asText("ACTIVE"))) continue;
            result.add(new Session(s.path("id").asText(),
                    s.path("title").isNull() ? null : s.path("title").asText(),
                    s.path("startedAt").asText("")));
        }
        // newest first
        result.sort((x, y) -> y.startedAt().compareTo(x.startedAt()));
        return result;
    }

    public Session createSession(String agentId) throws IOException, InterruptedException {
        String body = mapper.writeValueAsString(java.util.Map.of(
                "agentId", agentId, "namespace", NAMESPACE, "userId", userId));
        HttpResponse<String> response = http.send(HttpRequest.newBuilder(URI.create(base + "/api/sessions"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        expect2xx(response, "create session");
        JsonNode s = mapper.readTree(response.body());
        return new Session(s.path("id").asText(), null, s.path("startedAt").asText(""));
    }

    /** Chat bubbles plus, per turn, which tools ran — results stay server-side. */
    public List<HistoryEntry> history(String sessionId) throws IOException, InterruptedException {
        JsonNode messages = getJson("/api/sessions/" + sessionId + "/history");
        List<HistoryEntry> result = new ArrayList<>();
        for (JsonNode m : messages) {
            String type = m.path("type").asText();
            if ("CHAT".equals(type)) {
                result.add(new HistoryEntry(m.path("senderType").asText(), type,
                        m.path("content").asText(""), List.of()));
            } else if ("TOOL_CALL".equals(type)) {
                List<String> names = new ArrayList<>();
                try {
                    for (JsonNode call : mapper.readTree(m.path("content").asText("")).path("toolCalls")) {
                        names.add(call.path("name").asText());
                    }
                } catch (Exception ignored) {
                    // unreadable tool payload — skip the row rather than fail the view
                }
                if (!names.isEmpty()) result.add(new HistoryEntry(null, type, null, names));
            }
        }
        return result;
    }

    /**
     * Sends the message and blocks until the SSE stream closes, delivering
     * each frame to {@code onFrame}. Call it from a background thread.
     */
    public void chat(String sessionId, String message, Consumer<Frame> onFrame)
            throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(base + "/api/sessions/" + sessionId + "/chat"))
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(message))
                .build();
        HttpResponse<java.io.InputStream> response =
                http.send(request, HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() / 100 != 2) {
            throw new IOException("Server answered " + response.statusCode() + " for chat");
        }
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.startsWith("data:")) continue;
                onFrame.accept(parseFrame(mapper.readTree(line.substring(5).trim())));
            }
        }
    }

    private static Frame parseFrame(JsonNode frame) {
        return new Frame(
                frame.path("type").asText(),
                frame.path("text").isNull() ? null : frame.path("text").asText(),
                frame.path("toolName").isNull() ? null : frame.path("toolName").asText(),
                frame.path("agentName").isNull() ? null : frame.path("agentName").asText(),
                frame.path("finalText").isNull() ? null : frame.path("finalText").asText(),
                frame.path("error").isNull() ? null : frame.path("error").asText(),
                frame.path("durationMs").isNumber() ? frame.path("durationMs").asLong() : null,
                frame.path("arguments").isObject() ? frame.path("arguments").toPrettyString() : null,
                frame.path("inner").isObject() ? parseFrame(frame.path("inner")) : null);
    }

    // ── Approvals ───────────────────────────────────────────────────────────

    /**
     * The questions this conversation is still waiting on. The stream
     * announces one only in the moment it is raised, so a client that connects
     * later — or restarts — rebuilds its cards from here.
     */
    public List<Approval> openApprovals(String sessionId) throws IOException, InterruptedException {
        List<Approval> open = new ArrayList<>();
        for (JsonNode a : getJson("/api/sessions/" + sessionId + "/approvals")) {
            // The store keeps the raw call message; the card wants its two parts.
            JsonNode call = mapper.readTree(a.path("content").asText("{}"));
            open.add(new Approval(
                    a.path("callId").asText(),
                    a.path("toolName").asText(call.path("name").asText("?")),
                    call.path("arguments").isMissingNode() ? null
                            : call.path("arguments").toPrettyString()));
        }
        return open;
    }

    /**
     * Delivers the human's decision. {@code scope} is {@code once} or
     * {@code session}. A 404 means the card was stale — its task is gone — so
     * it is reported as such rather than as a failure to answer.
     */
    public void answerApproval(String sessionId, String callId, boolean approved, String scope)
            throws IOException, InterruptedException {
        String path = "/api/sessions/" + sessionId + "/approvals/"
                + URLEncoder.encode(callId, StandardCharsets.UTF_8)
                + "?approved=" + approved + "&scope=" + scope;
        HttpResponse<String> response = http.send(
                HttpRequest.newBuilder(URI.create(base + path))
                        .POST(HttpRequest.BodyPublishers.noBody()).build(),
                HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() == 404) {
            throw new IOException("This request is no longer open — the agent has moved on.");
        }
        expect2xx(response, "approval answer");
    }

    // ── Reattaching to a session ────────────────────────────────────────────

    /**
     * Attaches to the session's event stream and blocks until it ends,
     * delivering the opening {@link Attached} frame and then every event after
     * {@code afterSeq}. Call it from a background thread.
     *
     * @return false when the server does not know this endpoint — a build from
     *         before the session stream existed. Everything else still works
     *         there, so this is a fact to live with, not an error.
     */
    public boolean attach(String sessionId, long afterSeq,
                          Consumer<Attached> onAttached, Consumer<StreamFrame> onFrame)
            throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(
                        URI.create(base + "/api/sessions/" + sessionId + "/stream?afterSeq=" + afterSeq))
                .header("Accept", "text/event-stream")
                .build();
        HttpResponse<java.io.InputStream> response =
                http.send(request, HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() == 404) {
            response.body().close();
            return false;
        }
        if (response.statusCode() / 100 != 2) {
            throw new IOException("Server answered " + response.statusCode() + " for the session stream");
        }
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.startsWith("data:")) continue;
                JsonNode node = mapper.readTree(line.substring(5).trim());
                if ("attached".equals(node.path("type").asText())) {
                    onAttached.accept(new Attached(
                            node.path("firstBufferedSeq").asLong(),
                            node.path("latestSeq").asLong(),
                            node.path("liveTurnId").isNull() ? null : node.path("liveTurnId").asText(),
                            node.path("liveRun").isNull() ? null : node.path("liveRun").asInt()));
                    continue;
                }
                onFrame.accept(new StreamFrame(
                        node.path("seq").asLong(),
                        node.path("turnId").asText(null),
                        node.path("run").asInt(0),
                        parseFrame(node.path("event"))));
            }
        }
        return true;
    }

    public void cancel(String sessionId) throws IOException, InterruptedException {
        http.send(HttpRequest.newBuilder(URI.create(base + "/api/sessions/" + sessionId + "/chat"))
                        .DELETE().build(),
                HttpResponse.BodyHandlers.discarding());
    }

    private JsonNode getJson(String path) throws IOException, InterruptedException {
        HttpResponse<String> response = http.send(
                HttpRequest.newBuilder(URI.create(base + path)).build(),
                HttpResponse.BodyHandlers.ofString());
        expect2xx(response, path);
        return mapper.readTree(response.body());
    }

    private static void expect2xx(HttpResponse<?> response, String what) throws IOException {
        if (response.statusCode() / 100 != 2) {
            throw new IOException("Server answered " + response.statusCode() + " for " + what);
        }
    }
}
