package ai.mindconnect.agent.servercontrol.fx;

import ai.mindconnect.ui.javafx.FxNodeRenderer;
import ai.mindconnect.ui.javafx.FxRenderContext;
import ai.mindconnect.ui.model.UiScrollPane;
import javafx.scene.Node;
import javafx.scene.control.ScrollPane;
import javafx.scene.layout.Priority;
import javafx.scene.layout.VBox;

/**
 * Paints {@link UiScrollPane}, which the stock JavaFX renderer does not know
 * yet. Register it once per app:
 * {@code renderer.register(UiScrollPane.class, new ScrollPaneRenderer())}.
 *
 * <p>{@code stickToLatest} keeps the view glued to the bottom while content
 * grows — the chat-transcript behaviour.
 */
public final class ScrollPaneRenderer implements FxNodeRenderer<UiScrollPane> {

    @Override
    public Node render(UiScrollPane node, FxRenderContext ctx) {
        ScrollPane scroll = new ScrollPane();
        scroll.setFitToWidth(true);
        scroll.setHbarPolicy(ScrollPane.ScrollBarPolicy.NEVER);
        if (node.getContent() != null) {
            scroll.setContent(ctx.render(node.getContent()));
        }
        if (node.getMaxHeight() != null) {
            try {
                scroll.setPrefViewportHeight(Double.parseDouble(
                        node.getMaxHeight().replace("px", "").trim()));
            } catch (NumberFormatException ignored) {
                // model said something css-ish — the vgrow hint below still applies
            }
        }
        // If the surrounding stack is a VBox, take the free vertical space.
        VBox.setVgrow(scroll, Priority.ALWAYS);
        if (Boolean.TRUE.equals(node.getStickToLatest())) {
            scroll.vvalueProperty().addListener((obs, old, v) -> { /* keep user override */ });
            scroll.contentProperty().addListener((obs, old, content) -> hook(scroll));
            hook(scroll);
        }
        return scroll;
    }

    private void hook(ScrollPane scroll) {
        Node content = scroll.getContent();
        if (content == null) return;
        content.boundsInLocalProperty().addListener((obs, old, bounds) ->
                scroll.setVvalue(scroll.getVmax()));
    }
}
