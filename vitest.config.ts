import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      ENABLE_LOCAL_FACES: "false",
    },
    // Exclude tests that import from encore.dev (require Encore runtime)
    exclude: [
      "node_modules/**",
      "encore.gen/**",
    ],
    // Run test files sequentially to avoid DB data races (shared Postgres instance)
    fileParallelism: false,
  },
});

