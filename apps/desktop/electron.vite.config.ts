import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
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
    plugins: [react(), tailwindcss()],
  },
});
