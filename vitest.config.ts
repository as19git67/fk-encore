import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude tests that import from encore.dev (require Encore runtime)
    exclude: [
      "node_modules/**",
      "encore.gen/**",
      "hello/**",
    ],
  },
});

