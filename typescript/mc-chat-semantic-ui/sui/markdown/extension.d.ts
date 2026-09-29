import type { SuiRenderer } from "/sui/renderer.js";
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
export declare function install(renderer: SuiRenderer): Promise<void>;
