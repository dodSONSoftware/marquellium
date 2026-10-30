import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Vite options tailored for Tauri development.
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. communicate changes to the rust backend, don't restart the webview
      ignored: ["**/src-tauri/**"],
    },
  },
  // 4. build to a relative base so the packaged app loads from the local asset
  build: {
    target: "es2022",
    sourcemap: false,
    outDir: "dist",
    rollupOptions: {
      // mermaid ships a large dynamic chunk; keep it code-split so first paint
      // of the shell is not blocked by the diagram engine.
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/mermaid")) return "mermaid";
          if (id.includes("node_modules/katex")) return "katex";
          return undefined;
        },
      },
    },
  },
});
