import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built into dist/web and served by `mesh hub`. `pnpm dev:web` proxies the API to a local hub.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    proxy: {
      "/v1": { target: process.env.MESH_HUB_URL ?? "http://127.0.0.1:7700", changeOrigin: false },
      "/auth": { target: process.env.MESH_HUB_URL ?? "http://127.0.0.1:7700", changeOrigin: false },
    },
  },
});
