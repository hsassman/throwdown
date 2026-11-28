import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Lets the pose Web Worker load MediaPipe's WASM runtime in dev. */
function mediapipeWasmDevFix(): Plugin {
  const PREFIX = "/mediapipe/wasm/";
  return {
    name: "mediapipe-wasm-dev-fix",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith(PREFIX) && req.url.includes("?")) {
          req.url = req.url.split("?")[0];
        }
        next();
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), mediapipeWasmDevFix()],
  worker: {
    /** Build the pose worker as a classic (IIFE) worker, not an ES module. */
    format: "iife",
  },
});
