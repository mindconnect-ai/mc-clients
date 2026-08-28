package ai.mindconnect.agent.chat;

import ai.mindconnect.agent.servercontrol.ServerReleases;
import ai.mindconnect.agent.servercontrol.ServerHome;
import ai.mindconnect.agent.servercontrol.ServerProcess;
import ai.mindconnect.agent.servercontrol.fx.ScrollPaneRenderer;
import ai.mindconnect.agent.servercontrol.fx.ServerControlPanel;
import ai.mindconnect.ui.javafx.SuiFxEventBus;
import ai.mindconnect.ui.javafx.SuiFxOverlay;
import ai.mindconnect.ui.javafx.SuiFxRenderer;
import ai.mindconnect.ui.model.UiAction;
import ai.mindconnect.ui.model.UiField;
import ai.mindconnect.ui.model.UiForm;
import ai.mindconnect.ui.model.UiMenu;
import ai.mindconnect.ui.model.UiMenuItem;
import ai.mindconnect.ui.model.UiNode;
import ai.mindconnect.ui.model.UiPatch;
import ai.mindconnect.ui.model.UiScrollPane;
import ai.mindconnect.ui.model.UiStack;
import ai.mindconnect.ui.model.UiText;
import ai.mindconnect.ui.model.UiToast;
import ai.mindconnect.ui.model.UiTrigger;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.embed.swing.SwingFXUtils;
import javafx.scene.Scene;
import javafx.stage.Stage;

import javax.imageio.ImageIO;
import java.io.File;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The end-user chat window. A collapsible side menu (the Semantic UI menu
 * with its built-in toggle) holds the agents, the earlier conversations and
 * the server entry; the main area is the transcript in a scroll pane that
 * sticks to the latest message, with the input fixed below it. Tool calls
 * and sub-agents show as quiet lines between the bubbles.
 */
public class ChatApp extends Application {

    private final ServerHome home = new ServerHome();
    private final ServerReleases repository = new ServerReleases(home);
    private final ServerProcess ownServer = new ServerProcess(home, repository);
    private final ChatPrefs prefs = new ChatPrefs(home);

    private final SuiFxOverlay overlay = new SuiFxOverlay();
    private final SuiFxRenderer renderer = SuiFxRenderer.createDefaultRenderer(overlay);
    private final SuiFxEventBus bus = new SuiFxEventBus(renderer);

    private ServerControlPanel panel;

    private volatile List<ApiClient.Agent> agents = List.of();
    private volatile List<ApiClient.Session> sessions = List.of();
    private volatile String lastMenuSignature = "";
    private volatile String selectedAgentId;
    private volatile String currentSessionId;
    private volatile boolean showingServer;
    private volatile boolean sidebarCollapsed;
    private volatile boolean agentsOpen = true;
    private volatile boolean sessionsOpen = true;
    private volatile boolean serverOpen = true;
    private final AtomicBoolean turnRunning = new AtomicBoolean();
    private final AtomicInteger nodeIds = new AtomicInteger();

    @Override
    public void start(Stage stage) {
        renderer.register(UiScrollPane.class, new ScrollPaneRenderer());
        bus.setLinkOpener(url -> getHostServices().showDocument(url));
        panel = new ServerControlPanel(bus, home, repository, ownServer,
                url -> getHostServices().showDocument(url));
        panel.installHandlers();
        panel.setMounted(false);   // chat view first — server panels come on demand
        installHandlers();
        renderer.mount(ui());

        stage.setTitle("MindConnect Chat");
        Scene scene = new Scene(overlay, 1120, 740);
        scene.getStylesheets().add(getClass().getResource("/chat.css").toExternalForm());
        stage.setScene(scene);
        stage.show();

        panel.startPolling(this::onServerStatusChanged);
        if (panel.isReachable()) refreshAgentsInBackground();
        maybeAutotestSend(stage);
        maybeTakeScreenshotAndExit(stage);
    }

    @Override
    public void stop() throws Exception {
        // Only a server this window started dies with it; an adopted one
        // keeps running — it was there before us.
        panel.stopOwnServer();
    }

    private ApiClient api() {
        return new ApiClient("http://localhost:" + panel.port(), prefs.userId());
    }

    // ── the model ─────────────────────────────────────────────────────────

    private UiNode ui() {
        var root = UiStack.of(sideBar(), mainChat())
                .direction(UiStack.Direction.HORIZONTAL)
                .gap(20);
        root.setId("root");
        return root;
    }

    /**
     * The sidebar: the app owns the collapse state, so the hamburger really
     * frees the space — and rebuilding the menu never forgets it. The menu
     * sits in its own scroll pane so sixteen agents never grow taller than
     * the window; the wrapper stack exists because patches swap children of
     * a container, and a scroll pane's content is a property, not a child
     * list.
     */
    private UiNode sideBar() {
        UiStack bar;
        if (sidebarCollapsed) {
            bar = UiStack.of(UiAction.icon("sidebar-toggle", "☰")
                    .onClick(UiTrigger.invoke("toggleSidebar")));
            bar = (UiStack) bar.withCssClass("sidebar-rail");
        } else {
            var wrap = UiStack.of(sideMenu());
            wrap.setId("menu-wrap");
            bar = UiStack.of(
                    UiAction.icon("sidebar-toggle", "☰")
                            .onClick(UiTrigger.invoke("toggleSidebar")),
                    UiScrollPane.of("menu-scroll", wrap).maxHeight("620"));
            bar = (UiStack) bar.withCssClass("sidebar-scroll");
        }
        bar.setId("sidebar");
        return bar;
    }

    /** A section header the app toggles itself — state survives any repaint. */
    private UiMenuItem sectionHeader(String id, String label, boolean open, String handler) {
        return UiMenuItem.of(id, (open ? "▾ " : "▸ ") + label)
                .onClick(UiTrigger.invoke(handler));
    }

    private UiNode sideMenu() {
        List<UiMenuItem> agentItems = new ArrayList<>();
        for (ApiClient.Agent agent : agents) {
            agentItems.add(UiMenuItem.of("agent:" + agent.id(), agent.name())
                    .selected(agent.id().equals(selectedAgentId))
                    .onClick(UiTrigger.invoke("selectAgent")));
        }
        if (agentItems.isEmpty()) {
            agentItems.add(UiMenuItem.of("agent:none", "(no server)"));
        }

        List<UiMenuItem> sessionItems = new ArrayList<>();
        for (ApiClient.Session session : sessions) {
            String title = session.title() != null && !session.title().isBlank()
                    ? session.title() : "(untitled)";
            sessionItems.add(UiMenuItem.of("session:" + session.id(), title)
                    .selected(session.id().equals(currentSessionId))
                    .onClick(UiTrigger.invoke("openSession")));
        }
        if (sessionItems.isEmpty()) {
            sessionItems.add(UiMenuItem.of("session:none", "(none yet)"));
        }

        List<UiMenuItem> items = new ArrayList<>();
        items.add(UiMenuItem.of("new-chat", "＋ New chat")
                .onClick(UiTrigger.invoke("newChat")));
        items.add(sectionHeader("agents-header", "Agents", agentsOpen, "toggleAgents"));
        if (agentsOpen) items.addAll(agentItems);
        items.add(sectionHeader("sessions-header", "Conversations", sessionsOpen, "toggleSessions"));
        if (sessionsOpen) items.addAll(sessionItems);
        items.add(UiMenuItem.divider());
        items.add(sectionHeader("server-header", "Server — " + panel.statusShort(),
                serverOpen, "toggleServer"));
        if (serverOpen) {
            items.add(UiMenuItem.of("manage-server", showingServer
                            ? "Back to chat" : "Manage server…")
                    .onClick(UiTrigger.invoke("toggleServerView")));
            items.add(UiMenuItem.of("open-admin", "Open Admin UI")
                    .onClick(UiTrigger.invoke("openAdminUi")));
        }
        var menu = UiMenu.of("side-menu", "MindConnect", items.toArray(UiMenuItem[]::new));
        return menu.withCssClass("side-menu");
    }

    private UiNode mainChat() {
        return chatView(defaultEntries());
    }

    /** The chat main area with the given transcript entries already in place. */
    private UiNode chatView(List<UiNode> entries) {
        var main = UiStack.of(
                chatHeader(),
                UiScrollPane.of("transcript-scroll", transcriptStack(entries))
                        .stickToLatest(true).maxHeight("470"),
                turnStatus(""),
                chatForm());
        main.setId("main");
        return main;
    }

    private UiNode chatHeader() {
        ApiClient.Agent agent = selectedAgent();
        var name = UiText.of(agent != null ? agent.name() : "MindConnect Chat")
                .withCssClass("chat-header-name");
        var header = agent != null && agent.description() != null && !agent.description().isBlank()
                ? UiStack.of(name, UiText.of(agent.description()).withCssClass("chat-header-desc"))
                : UiStack.of(name);
        header.setId("chat-header");
        return header.withCssClass("chat-header");
    }

    /** The welcome message as the agent's first bubble, if it has one. */
    private List<UiNode> defaultEntries() {
        ApiClient.Agent agent = selectedAgent();
        if (agent != null && agent.welcomeMessage() != null && !agent.welcomeMessage().isBlank()) {
            return List.of(bubble(nextId("msg"), agent.name(), agent.welcomeMessage(), false));
        }
        return List.of(hintText());
    }

    private ApiClient.Agent selectedAgent() {
        for (ApiClient.Agent agent : agents) {
            if (agent.id().equals(selectedAgentId)) return agent;
        }
        return null;
    }

    private UiNode serverView() {
        var content = UiStack.of(
                panel.serverPanel(),
                panel.versionsPanel(),
                panel.environmentPanel());
        var main = UiStack.of(UiScrollPane.of("server-scroll", content).maxHeight("655"));
        main.setId("main");
        return main;
    }

    private UiStack transcriptStack(List<UiNode> entries) {
        var stack = UiStack.of(entries.toArray(UiNode[]::new));
        stack.setId("transcript");
        return (UiStack) stack.withCssClass("transcript");
    }

    private UiNode hintText() {
        return UiText.of("Pick an agent and say something — or open an earlier "
                + "conversation in the menu.");
    }

    private UiNode bubble(String id, String who, String text, boolean user) {
        var whoText = UiText.of(who).withCssClass("msg-who");
        var body = UiText.of(text == null || text.isBlank() ? "…" : text)
                .withCssClass("msg-body");
        var stack = UiStack.of(whoText, body)
                .withCssClass(user ? "user-message" : "bot-message");
        stack.setId(id);
        return stack;
    }

    private UiNode toolLine(String id, String text) {
        var line = UiText.of(text).withCssClass("tool-line");
        line.setId(id);
        return line;
    }

    private UiNode subLine(String id, String text) {
        var line = UiText.of(text).withCssClass("sub-line");
        line.setId(id);
        return line;
    }

    private UiNode turnStatus(String text) {
        var status = UiText.of(text).withCssClass("turn-status");
        status.setId("turn-status");
        return status;
    }

    private UiForm chatForm() {
        return UiForm.of("chat-form", null)
                .content(UiField.textarea("message", null, "").asEditable()
                        .placeholder("Type your message…"))
                .action(UiAction.primary("send", "Send")
                        .onClick(UiTrigger.invoke("sendMessage", "chat-form")))
                .action(UiAction.secondary("cancel-turn", "Cancel")
                        .onClick(UiTrigger.invoke("cancelTurn")));
    }

    private List<ApiClient.Session> fetchSessions() {
        if (selectedAgentId == null || selectedAgentId.isBlank() || !panel.isReachable()) {
            return List.of();
        }
        try {
            return api().listSessions(selectedAgentId);
        } catch (Exception e) {
            return List.of();
        }
    }

    /**
     * Repaints the side menu only when its content actually changed. A menu
     * replace resets the client-side collapse state of its groups, so every
     * needless repaint would fold everything open again.
     */
    private void patchMenuIfChanged() {
        sessions = fetchSessions();
        StringBuilder sig = new StringBuilder();
        sig.append(selectedAgentId).append('|').append(currentSessionId).append('|')
                .append(showingServer).append('|').append(panel.statusShort()).append('|')
                .append(agentsOpen).append(sessionsOpen).append(serverOpen)
                .append(sidebarCollapsed).append('|');
        for (ApiClient.Agent agent : agents) sig.append(agent.id()).append(',');
        sig.append('|');
        for (ApiClient.Session session : sessions) {
            sig.append(session.id()).append('=').append(session.title()).append(',');
        }
        String signature = sig.toString();
        if (signature.equals(lastMenuSignature)) return;
        lastMenuSignature = signature;
        bus.applyPatch(UiPatch.of()
                .patch(UiPatch.Operation.replace("side-menu", sideMenu())));
    }

    // ── handlers ──────────────────────────────────────────────────────────

    private void installHandlers() {
        bus.registerClientHandler("selectAgent", ctx -> {
            if (!(ctx.source() instanceof UiMenuItem item)) return;
            String agentId = item.getId().substring("agent:".length());
            if ("none".equals(agentId)) return;
            selectedAgentId = agentId;
            prefs.rememberAgent(agentId);
            currentSessionId = null;
            showingServer = false;
            bus.applyPatch(UiPatch.of()
                    .patch(UiPatch.Operation.replace("main", mainChat())));
            patchMenuIfChanged();
        });

        bus.registerClientHandler("newChat", ctx -> {
            currentSessionId = null;
            showingServer = false;
            bus.applyPatch(UiPatch.of()
                    .patch(UiPatch.Operation.replace("main", mainChat())));
            patchMenuIfChanged();
        });

        bus.registerClientHandler("openSession", ctx -> {
            if (!(ctx.source() instanceof UiMenuItem item)) return;
            String sessionId = item.getId().substring("session:".length());
            if ("none".equals(sessionId)) return;
            try {
                List<UiNode> entries = new ArrayList<>();
                for (ApiClient.HistoryEntry entry : api().history(sessionId)) {
                    if ("CHAT".equals(entry.type())) {
                        boolean user = "USER".equals(entry.senderType());
                        entries.add(bubble(nextId("msg"), user ? "You" : agentName(),
                                entry.content(), user));
                    } else {
                        for (String tool : entry.toolNames()) {
                            entries.add(toolLine(nextId("tool"), "⚙ " + tool));
                        }
                    }
                }
                currentSessionId = sessionId;
                showingServer = false;
                bus.applyPatch(UiPatch.of()
                        .patch(UiPatch.Operation.replace("main", chatView(entries))));
                patchMenuIfChanged();
            } catch (Exception e) {
                bus.toast(UiToast.error(String.valueOf(e.getMessage()))
                        .title("Cannot load conversation"));
            }
        });

        bus.registerClientHandler("toggleServerView", ctx -> {
            showingServer = !showingServer;
            panel.setMounted(showingServer);
            bus.applyPatch(UiPatch.of()
                    .patch(UiPatch.Operation.replace("main", showingServer ? serverView() : mainChat())));
            patchMenuIfChanged();
            if (showingServer) panel.refreshVersionsInBackground();
        });

        bus.registerClientHandler("sendMessage", ctx -> {
            String message = ctx.string("message");
            if (message == null || message.isBlank()) return;
            if (turnRunning.get()) {
                bus.toast(UiToast.info("One reply at a time — the agent is still answering."));
                return;
            }
            if (selectedAgentId == null || selectedAgentId.isBlank()) {
                bus.toast(UiToast.info("Pick an agent first."));
                return;
            }
            startTurn(message.trim());
        });

        bus.registerClientHandler("toggleSidebar", ctx -> {
            sidebarCollapsed = !sidebarCollapsed;
            bus.applyPatch(UiPatch.of()
                    .patch(UiPatch.Operation.replace("sidebar", sideBar())));
        });
        bus.registerClientHandler("toggleAgents", ctx -> {
            agentsOpen = !agentsOpen;
            patchMenuIfChanged();
        });
        bus.registerClientHandler("toggleSessions", ctx -> {
            sessionsOpen = !sessionsOpen;
            patchMenuIfChanged();
        });
        bus.registerClientHandler("toggleServer", ctx -> {
            serverOpen = !serverOpen;
            patchMenuIfChanged();
        });

        bus.registerClientHandler("cancelTurn", ctx -> {
            String sessionId = currentSessionId;
            if (sessionId == null || !turnRunning.get()) {
                bus.toast(UiToast.info("Nothing to cancel."));
                return;
            }
            try {
                api().cancel(sessionId);
                bus.toast(UiToast.info("Asked the agent to stop."));
            } catch (Exception e) {
                bus.toast(UiToast.error(String.valueOf(e.getMessage())));
            }
        });
    }

    /** The whole streaming turn, on its own thread so the window stays live. */
    private void startTurn(String message) {
        turnRunning.set(true);
        String botBubbleId = nextId("msg");
        bus.applyPatch(UiPatch.of()
                .patch(UiPatch.Operation.append("transcript",
                        bubble(nextId("msg"), "You", message, true)))
                .patch(UiPatch.Operation.replace("chat-form", chatForm()))
                .patch(UiPatch.Operation.replace("turn-status", turnStatus("The agent is thinking …"))));

        Thread worker = new Thread(() -> {
            StringBuilder answer = new StringBuilder();
            boolean[] botShown = {false};
            long[] lastPaint = {0};
            // open tool / sub-agent rows, newest last; results close the newest match
            Deque<String[]> openRows = new ArrayDeque<>();
            try {
                if (currentSessionId == null) {
                    currentSessionId = api().createSession(selectedAgentId).id();
                }
                api().chat(currentSessionId, message, frame -> {
                    ApiClient.Frame f = frame;
                    boolean indented = false;
                    if ("sub_agent_event".equals(f.type()) && f.inner() != null) {
                        f = f.inner();
                        indented = true;
                    }
                    switch (f.type()) {
                        case "token" -> {
                            if (indented) return;
                            if (f.text() != null) answer.append(f.text());
                            long now = System.currentTimeMillis();
                            if (!botShown[0]) {
                                botShown[0] = true;
                                appendRow(bubble(botBubbleId, agentName(), answer.toString(), false));
                            } else if (now - lastPaint[0] > 150) {
                                lastPaint[0] = now;
                                paintBot(botBubbleId, answer.toString());
                            }
                        }
                        case "tool_call_started" -> {
                            String id = nextId("tool");
                            openRows.push(new String[]{id, f.toolName()});
                            appendRow(toolLine(id, (indented ? "      ⚙ " : "⚙ ")
                                    + f.toolName() + " …"));
                        }
                        case "tool_call_result", "tool_call_failed" -> {
                            String[] row = popRow(openRows, f.toolName());
                            if (row != null) {
                                String mark = "tool_call_failed".equals(f.type()) ? "✗ " : "✓ ";
                                String duration = f.durationMs() != null
                                        ? " · " + (f.durationMs() < 1000 ? f.durationMs() + " ms"
                                                : (f.durationMs() / 100) / 10.0 + " s")
                                        : "";
                                replaceRow(row[0], toolLine(row[0], mark + f.toolName() + duration));
                            }
                        }
                        case "sub_agent_started" -> {
                            String id = nextId("sub");
                            openRows.push(new String[]{id, "sub:" + f.agentName()});
                            appendRow(subLine(id, "→ " + f.agentName() + " is working …"));
                        }
                        case "sub_agent_done", "sub_agent_error" -> {
                            String[] row = popRow(openRows, "sub:" + f.agentName());
                            if (row != null) {
                                String mark = "sub_agent_error".equals(f.type()) ? "✗ " : "✓ ";
                                replaceRow(row[0], subLine(row[0], mark + f.agentName()));
                            }
                        }
                        case "done" -> {
                            String finalText = f.finalText() != null && !f.finalText().isBlank()
                                    ? f.finalText() : answer.toString();
                            if (!botShown[0]) {
                                botShown[0] = true;
                                appendRow(bubble(botBubbleId, agentName(), finalText, false));
                            } else {
                                paintBot(botBubbleId, finalText);
                            }
                        }
                        case "error" -> {
                            if (!botShown[0]) {
                                botShown[0] = true;
                                appendRow(bubble(botBubbleId, agentName(),
                                        "Something went wrong: " + f.error(), false));
                            } else {
                                paintBot(botBubbleId, "Something went wrong: " + f.error());
                            }
                        }
                        default -> { /* internals the end user does not need */ }
                    }
                });
            } catch (Exception e) {
                appendRow(bubble(nextId("msg"), agentName(),
                        "Something went wrong: " + e.getMessage(), false));
            } finally {
                turnRunning.set(false);
                bus.applyPatch(UiPatch.of()
                        .patch(UiPatch.Operation.replace("turn-status", turnStatus(""))));
                // the server names new conversations after the first turn
                patchMenuIfChanged();
            }
        }, "chat-turn");
        worker.setDaemon(true);
        worker.start();
    }

    private static String[] popRow(Deque<String[]> rows, String name) {
        for (var it = rows.iterator(); it.hasNext(); ) {
            String[] row = it.next();
            if (row[1].equals(name)) {
                it.remove();
                return row;
            }
        }
        return null;
    }

    private void appendRow(UiNode node) {
        bus.applyPatch(UiPatch.of().patch(UiPatch.Operation.append("transcript", node)));
    }

    private void replaceRow(String id, UiNode node) {
        bus.applyPatch(UiPatch.of().patch(UiPatch.Operation.replace(id, node)));
    }

    private void paintBot(String bubbleId, String text) {
        replaceRow(bubbleId, bubble(bubbleId, agentName(), text, false));
    }

    private String nextId(String prefix) {
        return prefix + "-" + nodeIds.incrementAndGet();
    }

    private String agentName() {
        for (ApiClient.Agent agent : agents) {
            if (agent.id().equals(selectedAgentId)) return agent.name();
        }
        return "Agent";
    }

    // ── background refresh ────────────────────────────────────────────────

    private void refreshAgentsInBackground() {
        Thread thread = new Thread(() -> {
            try {
                agents = api().listAgents();
                if (selectedAgentId == null && prefs.selectedAgentId() != null
                        && agents.stream().anyMatch(a -> a.id().equals(prefs.selectedAgentId()))) {
                    selectedAgentId = prefs.selectedAgentId();
                }
                if (selectedAgentId == null && !agents.isEmpty()) {
                    selectedAgentId = agents.get(0).id();
                }
                if (currentSessionId == null && !showingServer && !turnRunning.get()) {
                    bus.applyPatch(UiPatch.of()
                            .patch(UiPatch.Operation.replace("main", mainChat())));
                }
                patchMenuIfChanged();
            } catch (Exception ignored) {
                // server not up yet — the status poller retries
            }
        }, "agents-refresh");
        thread.setDaemon(true);
        thread.start();
    }

    private void onServerStatusChanged() {
        patchMenuIfChanged();
        if (panel.isReachable() && agents.isEmpty()) refreshAgentsInBackground();
    }

    /** Test hook: -Dchat.autotest=<text> types into the real form and clicks Send. */
    private void maybeAutotestSend(Stage stage) {
        String text = System.getProperty("chat.autotest");
        if (text == null) return;
        Thread thread = new Thread(() -> {
            try {
                Thread.sleep(2500);   // agents loaded, main repainted
                Platform.runLater(() -> {
                    var area = stage.getScene().getRoot().lookup(".text-area");
                    if (area instanceof javafx.scene.control.TextArea ta) {
                        ta.setText(text);
                    } else {
                        System.out.println("AUTOTEST no textarea found: " + area);
                    }
                    for (var node : stage.getScene().getRoot().lookupAll(".button")) {
                        if (node instanceof javafx.scene.control.Button b
                                && "Send".equals(b.getText())) {
                            System.out.println("AUTOTEST clicking Send");
                            b.fire();
                            return;
                        }
                    }
                    System.out.println("AUTOTEST no send button found");
                });
            } catch (InterruptedException ignored) {
                // shutdown
            }
        }, "autotest");
        thread.setDaemon(true);
        thread.start();
    }

    /** Test hook: -Dchat.screenshot=/path.png renders, snapshots and exits. */
    private void maybeTakeScreenshotAndExit(Stage stage) {
        String target = System.getProperty("chat.screenshot");
        if (target == null) return;
        Thread thread = new Thread(() -> {
            try {
                Thread.sleep(Long.getLong("chat.screenshot.delay", 3000));
                Platform.runLater(() -> {
                    try {
                        if (System.getProperty("chat.debug") != null) {
                            for (String cls : new String[]{"chat-header", "transcript", "sui-uiscrollpane", "side-menu"}) {
                                var n = stage.getScene().getRoot().lookup("." + cls);
                                System.out.println("DEBUG " + cls + " -> "
                                        + (n == null ? "NOT FOUND" : n.localToScene(n.getBoundsInLocal())));
                            }
                            var sp = stage.getScene().getRoot().lookup(".scroll-pane");
                            System.out.println("DEBUG scroll-pane -> "
                                    + (sp == null ? "NOT FOUND" : sp.localToScene(sp.getBoundsInLocal())));
                        }
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
