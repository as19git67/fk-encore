import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./vitest.globalsetup.ts"],
    env: {
      ENABLE_LOCAL_FACES: "false",
      DB_TYPE: "postgres",
      POSTGRES_HOST: "localhost",
      POSTGRES_PORT: "5432",
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_TEST_DB: "encore_test",
      POSTGRES_TEST_CONNECTION_STRING: "postgres://postgres:postgres@localhost:5432/encore_test",
      RP_ID: "localhost",
      RP_NAME: "FK Encore App",
      RP_ORIGIN: "http://localhost:5173",
      NODE_ENV: "test",
    },
    exclude: [
      "node_modules/**",
      "encore.gen/**",
      "frontend/**",
    ],
    setupFiles: ["./vitest.setup.ts"],
    // Run test files sequentially to avoid DB data races (shared Postgres instance)
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      exclude: [
        "node_modules/**",
        "encore.gen/**",
        "frontend/**",
        "**/*.config.ts",
        "**/encore.service.ts",
        "db/seed.ts",
      ],
    },
  },
});
