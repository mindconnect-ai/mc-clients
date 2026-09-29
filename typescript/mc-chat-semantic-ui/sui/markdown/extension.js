import { escapeHtml } from "/sui/renderer.js";
/**
 * ESM build of marked@12 from jsdelivr. Resolved lazily on install so a host
 * that never includes the markdown extension pays nothing for it.
 */
const MARKED_ESM_URL = "https://cdn.jsdelivr.net/npm/marked@12/lib/marked.esm.js";
let loadPromise = null;
function loadMarked() {
    if (!loadPromise) {
        loadPromise = import(/* @vite-ignore */ MARKED_ESM_URL);
    }
    return loadPromise;
}
/**
 * Registers the {@code markdown} handler on the supplied renderer. Returns
 * a promise that resolves once {@code marked} is loaded; the renderer is
 * usable immediately because the handler is registered synchronously and the
 * library load is awaited inside the handler when needed.
 *
 * <p>The Markdown source is treated as trusted: the security boundary lies
 * with whoever produced the {@code content} string (typically server-side
 * authored copy or LLM output that has been reviewed upstream). Anchor tags
 * are rewritten to open in a new tab so links don't replace the SPA shell.
 */
export async function install(renderer) {
    let marked = null;
    renderer.register("markdown", (node) => {
        const className = node.cssClass
            ? `sui-markdown ${escapeHtml(node.cssClass)}`
            : "sui-markdown";
        const id = escapeHtml(node.id);
        // If the library is still resolving on the first render, we degrade
        // gracefully to an escaped <pre>. The renderer will re-paint on the
        // next patch / re-render once marked is loaded.
        if (!marked) {
            return `<div class="${className}" id="${id}"><pre>${escapeHtml(node.content ?? "")}</pre></div>`;
        }
        const raw = marked.parse(node.content ?? "");
        const html = raw.replace(/<a\s/g, '<a target="_blank" rel="noopener noreferrer" ');
        return `<div class="${className}" id="${id}">${html}</div>`;
    });
    const mod = await loadMarked();
    marked = mod.marked;
}
