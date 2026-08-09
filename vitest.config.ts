import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./vitest.globalsetup.ts"],
    // Most of this suite talks to a real Postgres, so the wall-clock cost of a
    // test tracks how loaded the host is rather than how much work the test
    // does. Vitest's 5s/10s defaults are comfortable on an idle machine and
    // far too tight on the CI host, where several service images build against
    // the same disk while these run — that combination produced spurious
    // "Test timed out in 5000ms" and "Hook timed out in 10000ms" failures in
    // tests that pass reliably otherwise. Local runs keep the tight defaults
    // so a genuine hang still surfaces quickly.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
    env: {
      ENABLE_LOCAL_FACES: "false",
      DB_TYPE: "postgres",
      // Postgres connection details fall back to a local instance but must
      // stay overridable from the real environment. `test.env` applies ONLY
      // inside the test workers, never in globalSetup — so hardcoding a host
      // here splits the two: globalSetup would create the test database on
      // the host CI provides, while every test file then looked for it
      // somewhere else and retried forever.
      //
      // This does not show up on a runner that publishes the database on the
      // host (as GitHub Actions does for service containers), but it does
      // wherever the job itself runs in a container and the database is only
      // reachable under a service hostname — the same pitfall the E2E
      // workflow already documents.
      //
      // `||` rather than `??` on purpose: an empty string should fall back
      // to the default, not be honoured as a host/port.
      POSTGRES_HOST: process.env.POSTGRES_HOST || "localhost",
      POSTGRES_PORT: process.env.POSTGRES_PORT || "5432",
      POSTGRES_USER: process.env.POSTGRES_USER || "postgres",
      POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || "postgres",
      POSTGRES_TEST_DB: process.env.POSTGRES_TEST_DB || "encore_test",
      POSTGRES_TEST_CONNECTION_STRING:
        process.env.POSTGRES_TEST_CONNECTION_STRING ||
        "postgres://postgres:postgres@localhost:5432/encore_test",
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
