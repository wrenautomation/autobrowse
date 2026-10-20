import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { env: { AUTOBROWSE_STATS: "off" }, testTimeout: 120_000, hookTimeout: 180_000 },
});
