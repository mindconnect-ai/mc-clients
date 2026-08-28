package ai.mindconnect.agent.adminlauncher;

import ai.mindconnect.agent.servercontrol.CentralRepository;
import ai.mindconnect.agent.servercontrol.ServerHome;
import ai.mindconnect.agent.servercontrol.ServerProcess;

import javafx.application.Application;

/**
 * Plain main class so the app starts from a classpath launch ({@code java -jar},
 * IDE run, {@code mvn javafx:run}) without module-path ceremony — the same
 * reason the semantic-ui demo has a separate launcher class.
 */
public final class LauncherMain {

    private LauncherMain() {
    }

    public static void main(String[] args) {
        Application.launch(LauncherApp.class, args);
    }
}
