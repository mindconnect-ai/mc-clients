package ai.mindconnect.agent.chat;

import javafx.application.Application;

/** Plain main class so the app starts from a classpath launch — see LauncherMain. */
public final class ChatMain {

    private ChatMain() {
    }

    public static void main(String[] args) {
        Application.launch(ChatApp.class, args);
    }
}
