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
 * needs: agents, sessions, history, and the SSE chat stream. Message bodies
 * and frames are the wire JSON, mapped to small records here.
 */
public final class ApiClient {

    public record Agent(String id, String name, String description, String welcomeMessage) {}

    public record Session(String id, String title, String startedAt) {}

    public record HistoryMessage(String senderType, String content) {}

    /** A transcript entry: a chat bubble, or the tools a turn used. */
    public record HistoryEntry(String senderType, String type, String content,
                               List<String> toolNames) {}

    /** One SSE frame of a running turn — only the fields the chat shows. */
    public record Frame(String type, String text, String toolName, String agentName,
                        String finalText, String error, Long durationMs, Frame inner) {}

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
                frame.path("inner").isObject() ? parseFrame(frame.path("inner")) : null);
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
