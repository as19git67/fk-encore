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
      RECAPS_EXPORT_DIR: "uploads/recap-exports",
    },
    // frontend/** is excluded entirely: those files rely on a DOM / Vue test
    // env we haven't wired up, and even the pure-utility tests under
    // frontend/src/utils/ trip vite:oxc with "Tsconfig not found" in CI's
    // Node 24 (locally on Node 22 the older oxc walks up to the root
    // tsconfig and is happy). When we add a dedicated frontend vitest
    // config we can re-enable them there.
    exclude: [
      "node_modules/**",
      "encore.gen/**",
      "frontend/**",
      // /geo is a standalone Node package shipped in its own container.
      // Its tests need a PostGIS instance the encore sandbox does not
      // have; run them inside the geo image instead.
      "geo/**",
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
        "geo/**",
        "**/*.config.ts",
        "**/encore.service.ts",
        "db/seed.ts",
      ],
    },
  },
});
