package ai.mindconnect.agent.chat;

import ai.mindconnect.agent.servercontrol.ServerHome;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

/**
 * What the chat client remembers between restarts — the selected agent and
 * the user it chats as. Lives next to the server's own settings so a wipe of
 * the home directory resets everything together.
 */
public final class ChatPrefs {

    private final Path file;
    private final Properties props = new Properties();

    public ChatPrefs(ServerHome home) {
        this.file = home.dir().resolve("chat-client.properties");
        if (Files.exists(file)) {
            try (var in = Files.newInputStream(file)) {
                props.load(in);
            } catch (IOException ignored) {
                // fall back to defaults; the next save rewrites the file
            }
        }
    }

    public String selectedAgentId() {
        return props.getProperty("agentId");
    }

    public void rememberAgent(String agentId) {
        props.setProperty("agentId", agentId);
        save();
    }

    /** Must match the server's user — the default server runs as mc_user. */
    public String userId() {
        return props.getProperty("userId", "mc_user");
    }

    private void save() {
        try (var out = Files.newOutputStream(file)) {
            props.store(out, "MindConnect chat client");
        } catch (IOException ignored) {
            // preferences are a convenience, never fatal
        }
    }
}
