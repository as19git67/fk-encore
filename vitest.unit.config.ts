import { defineConfig } from "vitest/config";

// Vitest config for pure-unit tests that do not need Postgres or the Encore
// runtime. Used for tests like backup/state.test.ts which exercise only
// module-local state.
export default defineConfig({
  test: {
    include: [
      "backup/state.test.ts",
      "documents/correspondent.test.ts",
      "documents/institutions.test.ts",
      "documents/document-filename.test.ts",
      "documents/filesystem-grouping.test.ts",
      "documents/metadata-extract.test.ts",
      "documents/ocr-layout.test.ts",
      "documents/ocr-preprocess.test.ts",
      "documents/pdf-rotate.test.ts",
      "documents/sender-rules.test.ts",
      "documents/tax-rules.test.ts",
      "documents/text-extract-warning.test.ts",
      "finance/sepa-parser.test.ts",
      "web/static-cache.test.ts",
    ],
    exclude: ["node_modules/**", "encore.gen/**", "frontend/**"],
    fileParallelism: false,
  },
});
