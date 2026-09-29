#!/usr/bin/env node
/*
 * VS Code theme preview for the Admin UI — no VS Code, no change to the server.
 *
 *   node dev/theme-preview/serve.mjs http://127.0.0.1:<port-of-a-running-server> [preview-port]
 *
 * Proxies a running MindConnect server and injects the prototype theme
 * (vscode.css) and host bridge (bridge.js) into its pages. The page at
 * /__preview/ plays VS Code: it frames the Admin UI with ?mc-host=vscode and
 * sends the colours of Dark Modern, Light Modern or High Contrast. Host page
 * and Admin UI share this origin, so the server's X-Frame-Options SAMEORIGIN
 * and its session cookie work as they are.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const upstream = new URL(process.argv[2] ?? process.env.MC_URL ?? "");
const port = Number(process.argv[3] ?? 18780);
const here = dirname(fileURLToPath(import.meta.url));
const asset = (name) => readFileSync(join(here, name)); // re-read per request: edit and reload
const INJECT = '<link rel="stylesheet" href="/__preview/vscode.css"><script src="/__preview/bridge.js"></script>';

http.createServer((req, res) => {
  const local = { "/__preview/": ["host.html", "text/html"], "/__preview/vscode.css": ["vscode.css", "text/css"], "/__preview/bridge.js": ["bridge.js", "text/javascript"] }[req.url.split("?")[0]];
  if (local) return void res.writeHead(200, { "content-type": `${local[1]}; charset=utf-8`, "cache-control": "no-store" }).end(asset(local[0]));

  const headers = { ...req.headers, host: upstream.host, "accept-encoding": "identity" };
  if (headers.origin) headers.origin = upstream.origin;
  const up = http.request(new URL(req.url, upstream), { method: req.method, headers }, (r) => {
    const out = { ...r.headers };
    if (typeof out.location === "string") {
      // The root redirects to /chat; the host marker must survive that.
      const to = new URL(out.location.replace(upstream.origin, `http://localhost:${port}`), `http://localhost:${port}`);
      const host = new URL(req.url, `http://localhost:${port}`).searchParams.get("mc-host");
      if (host && !to.searchParams.has("mc-host")) to.searchParams.set("mc-host", host);
      out.location = to.toString();
    }
    if (!String(r.headers["content-type"]).startsWith("text/html")) {
      res.writeHead(r.statusCode, out);
      return void r.pipe(res);
    }
    const chunks = [];
    r.on("data", (c) => chunks.push(c));
    r.on("end", () => {
      const html = Buffer.concat(chunks).toString("utf8").replace("</head>", `${INJECT}</head>`);
      delete out["content-length"];
      res.writeHead(r.statusCode, out).end(html);
    });
  });
  up.on("error", (e) => res.writeHead(502).end(`MindConnect server at ${upstream.origin} did not answer: ${e.message}`));
  req.pipe(up);
}).listen(port, "localhost", () => console.log(`Theme preview: http://localhost:${port}/__preview/  (server ${upstream.origin})`));
