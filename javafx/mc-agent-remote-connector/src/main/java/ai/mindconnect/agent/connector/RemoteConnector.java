package ai.mindconnect.agent.connector;

import com.google.auth.oauth2.GoogleCredentials;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.database.ChildEventListener;
import com.google.firebase.database.DataSnapshot;
import com.google.firebase.database.DatabaseError;
import com.google.firebase.database.DatabaseReference;
import com.google.firebase.database.FirebaseDatabase;
import com.google.firebase.database.ValueEventListener;

import java.io.FileInputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * The home end of the mobile relay, Firebase-only transport — the Java port
 * of {@code relay/connector/connector-rtdb.js}. No relay process, no open
 * port at home: the Realtime Database IS the relay, and this dials out to it.
 *
 * <pre>
 *   tunnels/{serverId}/online            presence (onDisconnect)
 *   tunnels/{serverId}/requests/{reqId}  {method, path, body} — phone writes;
 *                                        phone deletes to cancel
 *   tunnels/{serverId}/responses/{reqId} meta {status, headers, ts} → chunks/*
 *                                        (push children, in order) → done|error
 * </pre>
 *
 * <p>Access is gated entirely by the security rules (a hardwired verified
 * email); this side uses the admin SDK and bypasses them. Codeless — there is
 * no pairing here, matching the deployed setup.
 *
 * <p>Lifecycle: {@link #start()} once, {@link #stop()} once. Instances are not
 * reusable — build a fresh one to reconnect (e.g. after a config change).
 */
public final class RemoteConnector {

    /** Token streams arrive as many tiny SSE frames; writing each as its own
     *  RTDB child would be slow and chatty. Buffered ~6 writes/s still reads
     *  as live. Matches COALESCE_MS in the Node connector. */
    private static final long COALESCE_MS = 150;
    private static final long RESPONSE_TTL_MS = 10 * 60 * 1000;

    public enum State { STOPPED, STARTING, RUNNING, FAILED }

    private final ConnectorConfig config;
    private final TunnelProxy proxy;
    private final PushWatcher push;
    private final Consumer<String> log;
    private final Consumer<State> onState;

    private final Map<String, CancelToken> inflight = new ConcurrentHashMap<>();
    private final ExecutorService workers = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "connector-worker");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "connector-scheduler");
        t.setDaemon(true);
        return t;
    });

    private volatile State state = State.STOPPED;
    private FirebaseApp app;
    private DatabaseReference root;
    private ChildEventListener requestListener;
    private ValueEventListener presenceListener;
    private ScheduledFuture<?> sweepTask;

    public RemoteConnector(ConnectorConfig config, Consumer<String> log, Consumer<State> onState) {
        this.config = config;
        this.log = log != null ? log : m -> { };
        this.onState = onState != null ? onState : s -> { };
        this.push = new PushWatcher(config.apiBase(), ConnectorConfig.defaultPushStateFile(), this.log);
        this.proxy = new TunnelProxy(config.apiBase(), config.serverId(), push);
    }

    public State state() {
        return state;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    public synchronized void start() throws IOException {
        if (state != State.STOPPED) throw new IllegalStateException("connector already " + state);
        if (!config.isComplete()) throw new IOException("configuration incomplete: missing " + config.firstMissing());
        setState(State.STARTING);
        try {
            FirebaseOptions options;
            try (FileInputStream key = new FileInputStream(config.serviceAccountPath())) {
                options = FirebaseOptions.builder()
                        .setCredentials(GoogleCredentials.fromStream(key))
                        .setDatabaseUrl(config.rtdbUrl())
                        .build();
            }
            // A unique app name so we never collide with another FirebaseApp
            // the host process (the launcher) might have created.
            app = FirebaseApp.initializeApp(options, "mc-connector-" + config.serverId());
            root = FirebaseDatabase.getInstance(app).getReference("tunnels/" + config.serverId());

            // A previous run may have left half-answered frames behind.
            blocking(root.child("requests").removeValueAsync());
            blocking(root.child("responses").removeValueAsync());

            // Presence, done right: re-establish it on every (re)connect rather
            // than writing online=true once. A single write loses to a late
            // onDisconnect from a previous connector on the same id, and to our
            // own brief drop-and-reconnect — both would strand online=false.
            installPresence();

            requestListener = installRequestListener();
            sweepTask = scheduler.scheduleWithFixedDelay(this::sweepResponses, 60, 60, TimeUnit.SECONDS);
            push.start(app);

            setState(State.RUNNING);
            log.accept("codeless mode — access gated by the hardwired email in the security rules.");
            log.accept("rtdb connector up as " + config.serverId() + " → " + config.rtdbUrl()
                    + " (api " + config.apiBase() + ")");
        } catch (IOException | RuntimeException e) {
            setState(State.FAILED);
            cleanup();
            throw e instanceof IOException io ? io : new IOException(e.getMessage(), e);
        }
    }

    public synchronized void stop() {
        if (state == State.STOPPED) return;
        log.accept("connector stopping");
        try {
            if (root != null) blocking(root.child("online").setValueAsync(false));
        } catch (RuntimeException ignored) {
            // best effort — onDisconnect will clear presence anyway
        }
        cleanup();
        setState(State.STOPPED);
    }

    private void cleanup() {
        push.stop();
        if (presenceListener != null && app != null) {
            FirebaseDatabase.getInstance(app).getReference(".info/connected")
                    .removeEventListener(presenceListener);
            presenceListener = null;
        }
        if (requestListener != null && root != null) {
            root.child("requests").removeEventListener(requestListener);
            requestListener = null;
        }
        if (sweepTask != null) {
            sweepTask.cancel(false);
            sweepTask = null;
        }
        inflight.values().forEach(CancelToken::cancel);
        inflight.clear();
        if (app != null) {
            try {
                app.delete();
            } catch (RuntimeException ignored) {
                // already torn down
            }
            app = null;
        }
        root = null;
    }

    // ── Tunnel ───────────────────────────────────────────────────────────

    /**
     * The canonical Firebase presence pattern: watch {@code /.info/connected}
     * and, every time the client is connected, arm the onDisconnect and write
     * {@code online=true}. This overwrites a stale {@code false} left by a
     * previous connector and survives our own reconnects.
     */
    private void installPresence() {
        DatabaseReference online = root.child("online");
        DatabaseReference info = FirebaseDatabase.getInstance(app).getReference(".info/connected");
        presenceListener = new ValueEventListener() {
            @Override public void onDataChange(DataSnapshot snap) {
                if (Boolean.TRUE.equals(snap.getValue(Boolean.class))) {
                    online.onDisconnect().setValue(false, (e, ref) ->
                            online.setValueAsync(true));
                }
            }
            @Override public void onCancelled(DatabaseError error) {
                log.accept("presence listener cancelled: " + error.getMessage());
            }
        };
        info.addValueEventListener(presenceListener);
        // Set it now too, so a client that is already connected does not wait
        // for the first /.info/connected callback.
        blocking(online.setValueAsync(true));
    }

    private ChildEventListener installRequestListener() {
        ChildEventListener listener = new ChildEventListener() {
            @Override public void onChildAdded(DataSnapshot snap, String prev) {
                handleRequest(snap);
            }
            @Override public void onChildRemoved(DataSnapshot snap) {
                // The phone cancels by deleting its request node.
                CancelToken token = inflight.get(snap.getKey());
                if (token != null) token.cancel();
            }
            @Override public void onChildChanged(DataSnapshot snap, String prev) { }
            @Override public void onChildMoved(DataSnapshot snap, String prev) { }
            @Override public void onCancelled(DatabaseError error) {
                log.accept("request listener cancelled: " + error.getMessage());
                setState(State.FAILED);
            }
        };
        root.child("requests").addChildEventListener(listener);
        return listener;
    }

    private void handleRequest(DataSnapshot snap) {
        String reqId = snap.getKey();
        String method = str(snap.child("method"));
        String path = str(snap.child("path"));
        String body = str(snap.child("body"));
        String bodyBase64 = str(snap.child("bodyBase64"));
        String contentType = str(snap.child("contentType"));
        if (method == null || path == null) {
            root.child("requests/" + reqId).removeValueAsync();
            return;
        }
        workers.submit(() -> runRequest(reqId, method, path, body, bodyBase64, contentType));
    }

    private void runRequest(String reqId, String method, String path, String body,
                            String bodyBase64, String contentType) {
        DatabaseReference resRef = root.child("responses/" + reqId);
        CancelToken cancel = new CancelToken();
        inflight.put(reqId, cancel);

        // Per-request coalescing buffer, flushed on a schedule. Token streams
        // arrive as many tiny frames; one RTDB write each would be too chatty.
        StringBuilder buffer = new StringBuilder();
        Object bufferLock = new Object();
        ScheduledFuture<?>[] flushTask = { null };

        Runnable flush = () -> {
            String pending;
            synchronized (bufferLock) {
                if (buffer.length() == 0) return;
                pending = buffer.toString();
                buffer.setLength(0);
            }
            resRef.child("chunks").push().setValueAsync(pending);
        };

        TunnelProxy.Sink sink = new TunnelProxy.Sink() {
            @Override public void status(int status, String contentType) {
                Map<String, Object> meta = new HashMap<>();
                meta.put("status", status);
                meta.put("headers", Map.of("content-type", contentType));
                meta.put("ts", System.currentTimeMillis());
                resRef.child("meta").setValueAsync(meta);
            }
            @Override public void chunk(String text) {
                synchronized (bufferLock) {
                    buffer.append(text);
                    if (flushTask[0] == null) {
                        flushTask[0] = scheduler.schedule(() -> {
                            synchronized (bufferLock) { flushTask[0] = null; }
                            flush.run();
                        }, COALESCE_MS, TimeUnit.MILLISECONDS);
                    }
                }
            }
            @Override public void done() {
                finish("done", Boolean.TRUE);
            }
            @Override public void error(String message) {
                finish("error", message);
            }
            private void finish(String leaf, Object value) {
                synchronized (bufferLock) {
                    if (flushTask[0] != null) {
                        flushTask[0].cancel(false);
                        flushTask[0] = null;
                    }
                }
                flush.run();
                resRef.child(leaf).setValueAsync(value);
                inflight.remove(reqId);
                root.child("requests/" + reqId).removeValueAsync();
            }
        };

        try {
            proxy.execute(method, path, body, bodyBase64, contentType, sink, cancel);
        } finally {
            inflight.remove(reqId);
        }
    }

    // ── Maintenance ──────────────────────────────────────────────────────

    /** The phone deletes responses it has read; this catches the ones a phone
     *  that never came back left behind. */
    private void sweepResponses() {
        if (root == null) return;
        root.child("responses").addListenerForSingleValueEvent(new ValueEventListener() {
            @Override public void onDataChange(DataSnapshot snap) {
                long now = System.currentTimeMillis();
                for (DataSnapshot res : snap.getChildren()) {
                    Long ts = res.child("meta/ts").getValue(Long.class);
                    if (ts == null || now - ts > RESPONSE_TTL_MS) {
                        root.child("responses/" + res.getKey()).removeValueAsync();
                    }
                }
            }
            @Override public void onCancelled(DatabaseError error) { }
        });
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private void setState(State s) {
        state = s;
        onState.accept(s);
    }

    private static String str(DataSnapshot snap) {
        Object v = snap.getValue();
        return v == null ? null : v.toString();
    }

    private static void blocking(com.google.api.core.ApiFuture<Void> future) {
        try {
            future.get(15, TimeUnit.SECONDS);
        } catch (Exception e) {
            throw new RuntimeException(e.getMessage(), e);
        }
    }
}
