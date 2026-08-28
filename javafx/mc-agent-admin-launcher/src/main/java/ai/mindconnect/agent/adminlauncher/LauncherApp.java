package ai.mindconnect.agent.adminlauncher;

import ai.mindconnect.agent.servercontrol.ServerReleases;
import ai.mindconnect.agent.servercontrol.ServerHome;
import ai.mindconnect.agent.servercontrol.ServerProcess;
import ai.mindconnect.agent.servercontrol.fx.ServerControlPanel;
import ai.mindconnect.ui.javafx.SuiFxEventBus;
import ai.mindconnect.ui.javafx.SuiFxOverlay;
import ai.mindconnect.ui.javafx.SuiFxRenderer;
import ai.mindconnect.ui.model.UiDetail;
import ai.mindconnect.ui.model.UiField;
import ai.mindconnect.ui.model.UiLink;
import ai.mindconnect.ui.model.UiNode;
import ai.mindconnect.ui.model.UiSection;
import ai.mindconnect.ui.model.UiStack;
import ai.mindconnect.ui.model.UiText;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.embed.swing.SwingFXUtils;
import javafx.scene.Scene;
import javafx.stage.Stage;

import javax.imageio.ImageIO;
import java.io.File;

/**
 * The desktop launcher: a thin host around {@link ServerControlPanel} —
 * download a released server from Maven Central, pick a version, configure
 * the environment, start and stop. A server left running by an earlier run
 * is adopted via the pid file and shows up as running.
 */
public class LauncherApp extends Application {

    private final ServerHome home = new ServerHome();
    private final ServerReleases repository = new ServerReleases(home);
    private final ServerProcess server = new ServerProcess(home, repository);

    private final SuiFxOverlay overlay = new SuiFxOverlay();
    private final SuiFxRenderer renderer = SuiFxRenderer.createDefaultRenderer(overlay);
    private final SuiFxEventBus bus = new SuiFxEventBus(renderer);

    private ServerControlPanel panel;

    @Override
    public void start(Stage stage) {
        panel = new ServerControlPanel(bus, home, repository, server,
                url -> getHostServices().showDocument(url));
        panel.installHandlers();
        renderer.mount(ui());

        stage.setTitle("MindConnect Admin Launcher");
        applyBrandIcon(stage);
        stage.setScene(new Scene(overlay, 1000, 720));
        stage.show();

        panel.startPolling(null);
        panel.refreshVersionsInBackground();
        maybeTakeScreenshotAndExit(stage);
    }

    @Override
    public void stop() throws Exception {
        // Only a server this window started dies with it; an adopted one
        // keeps running — it was there before us.
        panel.stopOwnServer();
    }

    private UiNode ui() {
        return UiSection.of("main", null)
                .section("server", "Server", panel.serverPanel())
                .section("versions", "Versions", panel.versionsPanel())
                .section("environment", "Environment", panel.environmentPanel())
                .section("about", "About", aboutPanel())
                .initialSection("server");
    }

    private UiNode aboutPanel() {
        return UiStack.of(
                UiDetail.of("about-paths", "This launcher")
                        .field(UiField.text("home", "Home directory", home.dir().toString()))
                        .field(UiField.text("env", "Settings", home.envFile().toString()))
                        .field(UiField.text("log", "Server log", home.logFile().toString())),
                UiText.of("The launcher, the chat client, the shell scripts and a manual "
                        + "`java -jar` all share this home directory — settings and downloads "
                        + "made here work there too."),
                UiLink.external("repo", "https://github.com/mindconnect-ai", "MindConnect on GitHub"));
    }

    /** The brain icon on the window and, where the OS shows one, the dock/taskbar. */
    private void applyBrandIcon(Stage stage) {
        var icon = getClass().getResourceAsStream("/icon.png");
        if (icon == null) return;
        var image = new javafx.scene.image.Image(icon);
        stage.getIcons().add(image);
        try {
            // macOS dock (when running from a jar — the packaged app brings its own .icns)
            var awtImage = java.awt.Toolkit.getDefaultToolkit()
                    .getImage(getClass().getResource("/icon.png"));
            java.awt.Taskbar.getTaskbar().setIconImage(awtImage);
        } catch (Exception | UnsatisfiedLinkError ignored) {
            // taskbar icons are unsupported on some platforms — the window icon stands
        }
    }

    /** Test hook: -Dlauncher.screenshot=/path.png renders, snapshots and exits. */
    private void maybeTakeScreenshotAndExit(Stage stage) {
        String target = System.getProperty("launcher.screenshot");
        if (target == null) return;
        Thread thread = new Thread(() -> {
            try {
                Thread.sleep(2500);
                Platform.runLater(() -> {
                    try {
                        var image = stage.getScene().snapshot(null);
                        ImageIO.write(SwingFXUtils.fromFXImage(image, null), "png", new File(target));
                    } catch (Exception e) {
                        e.printStackTrace();
                    } finally {
                        Platform.exit();
                    }
                });
            } catch (InterruptedException ignored) {
                // shutdown
            }
        }, "screenshot-hook");
        thread.setDaemon(true);
        thread.start();
    }
}
