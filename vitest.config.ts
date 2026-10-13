import { configDefaults, defineConfig } from "vitest/config";
// track/ is its own package with its own tests (cd track && pnpm test).
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 180_000,
    exclude: [...configDefaults.exclude, "track/**"],
  },
});
