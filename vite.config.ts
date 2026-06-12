import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(root, "src/web"),
  plugins: [react()],
  build: {
    outDir: resolve(root, "dist/web"),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/events": "http://127.0.0.1:4317",
    },
  },
});
