import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Renderer-only Vite config. Main + preload are compiled by tsc (see tsconfig.json).
// Renderer bundle output: dist/renderer/index.html + assets/*.js
// main.ts loads dist/renderer/index.html via app.getAppPath() resolution.
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome120",
    rollupOptions: {
      input: resolve(__dirname, "src/renderer/index.html"),
    },
  },
  server: { port: 5173 },
});
