import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Dev: the SPA on :5173 proxies to the worker's API on :9080. Build: ui/dist, served by the worker. */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:9080", changeOrigin: true },
      "/hooks": { target: "http://127.0.0.1:9080", changeOrigin: true },
    },
  },
});
