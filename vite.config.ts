import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Lets the pose Web Worker load MediaPipe's WASM runtime in dev.
 *
 * FilesetResolver dynamically imports the emscripten glue (vision_wasm_*.js)
 * at runtime. When that import originates inside a module worker, Vite's dev
 * server appends `?import` to the request - and for a static file under
 * public/ that query makes Vite try to resolve it as a module graph entry,
 * which fails with a 500 ("Failed to load url ..."). The main-thread path
 * doesn't hit this, so it only shows up once inference moves off-thread.
 *
 * Stripping the query for this one directory hands back the plain static file.
 * Dev-only: a production build serves these as ordinary static assets with no
 * query attached.
 */
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
    /**
     * Build the pose worker as a classic (IIFE) worker, not an ES module.
     *
     * MediaPipe's FilesetResolver loads its WASM glue with importScripts(),
     * which does not exist in module workers. Loading that glue as an ES
     * module instead fails with "ModuleFactory not set", because the glue
     * declares its factory as a top-level var - global in a classic script,
     * but module-scoped (and therefore invisible) in an ES module.
     */
    format: "iife",
  },
});
