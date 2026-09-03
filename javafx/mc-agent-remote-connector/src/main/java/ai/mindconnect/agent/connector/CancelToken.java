package ai.mindconnect.agent.connector;

/**
 * A one-shot cancel signal for an in-flight tunneled request. The phone
 * cancels by deleting its request node; the connector calls {@link #cancel()},
 * which closes the local response stream so the blocking read unwinds.
 *
 * <p>Race-safe both ways: if cancel arrives before the stream is open, the
 * closer runs the moment it is {@link #arm(Runnable) armed}; if it arrives
 * after, it runs immediately.
 */
public final class CancelToken {

    private Runnable onCancel;
    private boolean cancelled;

    public synchronized void cancel() {
        cancelled = true;
        if (onCancel != null) {
            Runnable r = onCancel;
            onCancel = null;
            r.run();
        }
    }

    /** Register the action that aborts the read (closing the stream). Runs now
     *  if cancellation already happened. */
    synchronized void arm(Runnable closer) {
        if (cancelled) {
            closer.run();
        } else {
            onCancel = closer;
        }
    }

    public synchronized boolean isCancelled() {
        return cancelled;
    }
}
