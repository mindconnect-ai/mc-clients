// The sprite lives next to the compiled bundle: renderers/icon.js →
// ../icons.svg = /sui/icons.svg. Resolving against import.meta.url means the
// same code works when served from a Spring app (/sui/…) and from jsDelivr
// (…/sui/…) with zero configuration.
const DEFAULT_SPRITE_URL = new URL("../icons.svg", import.meta.url).href;
function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
/**
 * The default resolver: one {@code <svg><use></svg>} into a sprite. Size is
 * {@code 1em} (via {@code .sui-icon} CSS) and color is {@code currentColor},
 * so an icon inherits the surrounding text's size and color.
 */
export function spriteIconResolver(spriteUrl) {
    return (name, opts) => {
        const cls = "sui-icon" + (opts.cssClass ? " " + esc(opts.cssClass) : "");
        const idAttr = opts.id ? ` id="${esc(opts.id)}"` : "";
        const a11y = opts.title
            ? `role="img" aria-label="${esc(opts.title)}"`
            : `aria-hidden="true"`;
        const titleEl = opts.title ? `<title>${esc(opts.title)}</title>` : "";
        return `<svg${idAttr} class="${cls}" ${a11y}>${titleEl}<use href="${esc(spriteUrl)}#${esc(name)}"></use></svg>`;
    };
}
let activeResolver = spriteIconResolver(DEFAULT_SPRITE_URL);
/**
 * Swaps the active icon resolver process-wide (one page = one resolver).
 * Pass {@link spriteIconResolver} with a different URL to use another sprite,
 * or a custom function to emit inline SVG / an icon-font element / anything.
 */
export function setIconResolver(resolver) {
    activeResolver = resolver;
}
/** Convenience: point the default sprite resolver at a different sprite URL. */
export function setIconSpriteUrl(spriteUrl) {
    activeResolver = spriteIconResolver(spriteUrl);
}
// Sprite ids are lowercase-kebab (`folder`, `trash-2`, `circle-check`).
// Anything else — an emoji, a bullet, arbitrary text — is treated as a
// literal glyph and passed through verbatim. This is the migration path:
// legacy `icon: "📁"` data keeps rendering as the emoji, while
// `icon: "folder"` resolves to the sprite. No flag day.
const TOKEN_RE = /^[a-z][a-z0-9-]*$/;
/**
 * Renders an icon to HTML. A token that matches the sprite-id shape goes
 * through the active resolver (SVG by default); any other string (emoji,
 * text) is emitted verbatim as a literal glyph. Returns {@code ""} for a
 * null/blank value so callers can inline it unconditionally:
 * {@code `${renderIcon(node.icon)}<span>…`}.
 */
export function renderIcon(name, opts = {}) {
    if (name == null || name === "")
        return "";
    if (!TOKEN_RE.test(name)) {
        // Literal glyph (emoji / text). Keep any requested class/id so callers
        // can still style/address the slot consistently.
        const cls = opts.cssClass ? ` class="${esc(opts.cssClass)}"` : "";
        const idAttr = opts.id ? ` id="${esc(opts.id)}"` : "";
        return `<span${idAttr}${cls} aria-hidden="true">${esc(name)}</span>`;
    }
    return activeResolver(name, opts);
}
/** Renderer for the standalone {@link UiIcon} node (type {@code "icon"}). */
export function renderIconNode(node) {
    return renderIcon(node.name, { cssClass: node.cssClass, title: node.title, id: node.id });
}
