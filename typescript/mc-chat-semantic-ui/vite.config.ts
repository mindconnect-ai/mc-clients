import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// The agent server's REST API is proxied in dev so the browser talks to the
// same origin and no CORS is involved. Point it at wherever the server runs.
const API_TARGET = process.env.MC_API ?? "http://localhost:9090";
const suiDir = fileURLToPath(new URL("./sui", import.meta.url));

export default defineConfig({
  resolve: {
    // The Semantic UI runtime is vendored under ./sui and consumed via the
    // framework's absolute "/sui/..." import convention (the app and the
    // markdown extension both use it). Aliasing it into a real source folder
    // lets Vite treat it as modules in dev AND bundle it on build — unlike
    // /public, which serves files as-is and can't be imported.
    alias: [{ find: /^\/sui\//, replacement: suiDir + "/" }],
  },
  server: {
    port: 5174,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
});
