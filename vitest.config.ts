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
      // Tests must not write to the container default (/mnt/data/...). Pin
      // to a project-relative path so vitest runs in a sandbox/CI.
      PHOTO_UPLOAD_DIR: "uploads/photos",
      PHOTO_THUMBNAIL_DIR: "uploads/thumbnails",
    },
    // Most of frontend/ is excluded because it depends on a browser DOM /
    // Vue test environment we haven't wired up. Pure utility modules under
    // frontend/src/utils/ are plain TS and CAN run here, so we leave them
    // included.
    exclude: [
      "node_modules/**",
      "encore.gen/**",
      "frontend/node_modules/**",
      "frontend/dist/**",
      "frontend/storybook-static/**",
      "frontend/playwright-report/**",
      "frontend/e2e/**",
      "frontend/.storybook/**",
      "frontend/src/components/**",
      "frontend/src/views/**",
      "frontend/src/stories/**",
      "frontend/src/router/**",
      "frontend/src/composables/**",
      "frontend/src/stores/**",
      "frontend/src/api/**",
      "frontend/src/services/**",
      "frontend/src/config/**",
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
