package ai.mindconnect.agent.connector;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * The transport-independent half of the connector: replay one tunneled HTTP
 * frame against the local API (or the connector's own {@code /relay/**}
 * control surface) and report the answer through a {@link Sink}. The Java
 * port of {@code relay/connector/api-proxy.js}.
 *
 * <p>Only {@code /api/**} and {@code /relay/**} are tunneled — the bridge is
 * not a general proxy into the home network. Bodies and responses travel as
 * UTF-8 text; the API is JSON and SSE throughout, so streaming just forwards
 * decoded chunks as they arrive.
 */
public final class TunnelProxy {

    /** Where the connector reports a request's outcome, in order:
     *  {@code status} once, then any number of {@code chunk}, then exactly one
     *  terminal {@code done} or {@code error}. */
    public interface Sink {
        void status(int status, String contentType);
        void chunk(String text);
        void done();
        void error(String message);
    }

    private final String apiBase;
    private final String serverId;
    private final PushWatcher push; // nullable — no push routes without it
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    public TunnelProxy(String apiBase, String serverId, PushWatcher push) {
        this.apiBase = apiBase;
        this.serverId = serverId;
        this.push = push;
    }

    /**
     * Replay one frame, blocking until the local response is fully streamed
     * (or cancelled) — call it on a worker thread. {@code cancel} lets a
     * {@code child_removed} signal abort a long-lived stream mid-read.
     *
     * <p>A text {@code body} travels as JSON; a {@code bodyBase64} carries raw
     * bytes (a file upload's multipart payload) with an explicit
     * {@code contentType}, so binary rides the text-only tunnel intact.
     */
    public void execute(String method, String path, String body, String bodyBase64,
                        String contentType, Sink sink, CancelToken cancel) {
        if (path.startsWith("/relay/")) {
            handleLocal(method, path, body, sink);
            return;
        }
        if (!path.startsWith("/api/")) {
            sink.error("only /api/** and /relay/** are tunneled");
            return;
        }

        try {
            HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(apiBase + path))
                    .timeout(Duration.ofMinutes(10))
                    .header("accept", "text/event-stream, application/json");
            if (bodyBase64 != null) {
                byte[] bytes = java.util.Base64.getDecoder().decode(bodyBase64);
                req.header("content-type", contentType != null ? contentType : "application/octet-stream")
                        .method(method, HttpRequest.BodyPublishers.ofByteArray(bytes));
            } else if (body != null) {
                req.header("content-type", "application/json")
                        .method(method, HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
            } else {
                req.method(method, HttpRequest.BodyPublishers.noBody());
            }

            HttpResponse<InputStream> res = http.send(req.build(), HttpResponse.BodyHandlers.ofInputStream());
            String responseType = res.headers().firstValue("content-type").orElse("application/json");
            sink.status(res.statusCode(), responseType);

            try (InputStream in = res.body()) {
                cancel.arm(() -> closeQuietly(in));
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (cancel.isCancelled()) break;
                    if (n > 0) sink.chunk(new String(buf, 0, n, StandardCharsets.UTF_8));
                }
            }
            if (!cancel.isCancelled()) sink.done();
        } catch (IOException e) {
            // A cancel closes the stream and surfaces here as an IOException —
            // that is expected teardown, not a failure to report.
            if (!cancel.isCancelled()) sink.error(e.getMessage() == null ? e.toString() : e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            if (!cancel.isCancelled()) sink.error("interrupted");
        }
    }

    /** The connector's own control surface: a health probe plus the push
     *  watcher's token/watch routes. */
    private void handleLocal(String method, String path, String body, Sink sink) {
        String route = path.contains("?") ? path.substring(0, path.indexOf('?')) : path;
        if ("GET".equals(method) && "/relay/ping".equals(route)) {
            reply(sink, 200, "{\"ok\":true,\"serverId\":\"" + jsonEscape(serverId)
                    + "\",\"apiBase\":\"" + jsonEscape(apiBase) + "\"}");
            return;
        }
        if (route.startsWith("/relay/push/") && push != null) {
            try {
                String result = push.control(route, body);
                if (result != null) {
                    reply(sink, 200, result);
                    return;
                }
            } catch (IOException e) {
                reply(sink, 400, "{\"error\":\"" + jsonEscape(e.getMessage()) + "\"}");
                return;
            }
        }
        reply(sink, 404, "{\"error\":\"unknown relay route " + jsonEscape(route) + "\"}");
    }

    private static void reply(Sink sink, int status, String json) {
        sink.status(status, "application/json");
        sink.chunk(json);
        sink.done();
    }

    private static void closeQuietly(InputStream in) {
        try {
            in.close();
        } catch (IOException ignored) {
            // closing to interrupt the blocking read; nothing to recover
        }
    }

    static String jsonEscape(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
