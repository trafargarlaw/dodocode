import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Each bundle gets a source map beside it, which the bundle does not name: tools/perfq reads them to
// show a trace's functions at their source lines. electron-builder leaves them out of the app.
const sourcemap = "hidden";

export default defineConfig({
  main: {
    build: {
      sourcemap,
      rolldownOptions: {
        // The server runs in its own utility process, started by the main process.
        input: {
          index: resolve("src/main/index.ts"),
          server: resolve("../server/src/main.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      sourcemap,
      // Sandboxed preload scripts cannot be ES modules, so the preload is built as CommonJS.
      lib: {
        entry: resolve("src/preload/index.ts"),
        formats: ["cjs"],
        fileName: () => "index.cjs",
      },
    },
  },
  renderer: {
    resolve: {
      alias: { "@": resolve("src/renderer") },
    },
    build: { sourcemap },
    plugins: [react(), tailwindcss()],
  },
});
