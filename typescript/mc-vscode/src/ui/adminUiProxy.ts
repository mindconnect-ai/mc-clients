import * as http from "node:http";
import * as net from "node:net";
import * as vscode from "vscode";

/**
 * Puts the Admin UI inside a VS Code webview. Two things stand in the way,
 * and this reverse proxy on 127.0.0.1 removes both:
 *
 * - the server answers with X-Frame-Options: SAMEORIGIN, so an iframe in the
 *   webview (another origin) stays blank;
 * - its session cookie is SameSite=Lax by default, and an iframe under a
 *   vscode-webview:// page is a cross-site context — the browser would not
 *   send it back.
 *
 * The proxy keeps the cookies itself — one local user, one jar — and hands
 * the iframe none. Redirects to the server's own address are rewritten to
 * the proxy's; streams (SSE) and WebSocket upgrades pass through.
 *
 * That makes the proxy a door into the Admin UI, so it only opens for
 * VS Code: framing is limited to VS Code's own origins (frame-ancestors),
 * a Host other than its own address is refused (DNS rebinding), and a
 * browser request from another site is refused unless it is the webview
 * loading the frame (Sec-Fetch-*, Origin).
 */

/** Who may frame the Admin UI: the webview, and the workbench above it (desktop). */
const FRAME_ANCESTORS = "frame-ancestors 'self' vscode-webview: vscode-file:";
export class AdminUiProxy implements vscode.Disposable {
  private server: http.Server | undefined;
  private port = 0;
  private readonly jar = new Map<string, string>();
  private upstream: string | undefined;

  constructor(private readonly log: vscode.LogOutputChannel) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Points the proxy at a server; a new server starts with an empty jar. */
  setTarget(url: string | undefined): void {
    if (url !== this.upstream) this.jar.clear();
    this.upstream = url;
  }

  async start(): Promise<string> {
    if (this.server) return this.url;
    const server = http.createServer((req, res) => this.forward(req, res));
    server.on("upgrade", (req, socket: net.Socket, head) => this.tunnel(req, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    return this.url;
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    const refused = this.refusal(req);
    if (refused) {
      this.log.warn(`Admin UI proxy refused ${req.method} ${req.url}: ${refused}`);
      res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
      return;
    }
    const target = this.upstream;
    if (!target) {
      res.writeHead(503, { "content-type": "text/plain" }).end("The MindConnect server is not running.");
      return;
    }
    const origin = new URL(target);
    const upstreamReq = http.request(
      new URL(req.url ?? "/", target),
      { method: req.method, headers: this.requestHeaders(req, origin) },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, this.responseHeaders(up, origin, req.url ?? "/"));
        up.pipe(res);
      },
    );
    upstreamReq.on("error", (e) => {
      this.log.warn(`Admin UI proxy: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("The MindConnect server did not answer.");
    });
    req.pipe(upstreamReq);
  }

  private tunnel(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const target = this.upstream;
    const refused = this.refusal(req);
    if (refused) this.log.warn(`Admin UI proxy refused a WebSocket to ${req.url}: ${refused}`);
    if (!target || refused) return void socket.destroy();
    const origin = new URL(target);
    const upstream = net.connect(Number(origin.port || 80), origin.hostname, () => {
      const headers = this.requestHeaders(req, origin);
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) lines.push(`${name}: ${v}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", close);
    socket.on("error", close);
  }

  /**
   * Why a request may not pass, or undefined when it may. Requests without
   * Sec-Fetch-Site come from programs on this machine, which reach the server
   * directly anyway; browsers send it, and a page of another site gets one
   * thing only — the GET that loads the frame, which frame-ancestors then
   * lets only VS Code render.
   */
  private refusal(req: http.IncomingMessage): string | undefined {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return `unexpected Host ${host}`;
    const origin = req.headers.origin;
    if (origin && origin !== this.url && origin !== `http://localhost:${this.port}`) return `foreign Origin ${origin}`;
    const site = req.headers["sec-fetch-site"];
    if (site === undefined || site === "same-origin" || site === "none") return undefined;
    const framing = req.method === "GET" && req.headers["sec-fetch-dest"] === "iframe" && req.headers["sec-fetch-mode"] === "navigate";
    return framing ? undefined : `${site} ${req.headers["sec-fetch-dest"] ?? "request"}`;
  }

  /** The browser's request as the server should see it: its own host and origin, the jar's cookies. */
  private requestHeaders(req: http.IncomingMessage, origin: URL): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: origin.host };
    delete headers.cookie;
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (headers.origin) headers.origin = origin.origin;
    if (typeof headers.referer === "string") headers.referer = headers.referer.replace(this.url, origin.origin);
    return headers;
  }

  private responseHeaders(up: http.IncomingMessage, origin: URL, requestUrl: string): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...up.headers };
    for (const cookie of up.headers["set-cookie"] ?? []) this.remember(cookie);
    delete headers["set-cookie"];
    // SAMEORIGIN would keep the webview out; frame-ancestors takes its place, naming VS Code.
    delete headers["x-frame-options"];
    const csp = typeof headers["content-security-policy"] === "string" ? headers["content-security-policy"] : "";
    const kept = csp.split(";").map((d) => d.trim()).filter((d) => d && !/^frame-ancestors\b/i.test(d));
    headers["content-security-policy"] = [...kept, FRAME_ANCESTORS].join("; ");
    if (typeof headers.location === "string") {
      headers.location = this.rewriteLocation(headers.location, origin, requestUrl);
    }
    return headers;
  }

  /**
   * A redirect to the server's own address goes to the proxy's instead, and
   * the host marker (?mc-host=vscode, see AdminUi) rides along: the root
   * redirects to /chat, and the Admin UI reads the marker from wherever it
   * lands first.
   */
  private rewriteLocation(location: string, origin: URL, requestUrl: string): string {
    const to = new URL(location.startsWith(origin.origin) ? this.url + location.slice(origin.origin.length) : location, this.url);
    if (to.origin !== this.url) return location;
    const host = new URL(requestUrl, this.url).searchParams.get("mc-host");
    if (host && !to.searchParams.has("mc-host")) to.searchParams.set("mc-host", host);
    return to.toString();
  }

  private remember(setCookie: string): void {
    const [pair, ...attributes] = setCookie.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attributes.some((a) => {
      const [k, v] = a.split("=").map((s) => s?.trim().toLowerCase());
      return (k === "max-age" && Number(v) <= 0) || (k === "expires" && Date.parse(v) < Date.now());
    });
    if (expired || !value) this.jar.delete(name);
    else this.jar.set(name, value);
  }
}
