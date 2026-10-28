-- Assistant benchmark, stage 6 part 2 of
-- documentation/plans/assistent-wegfindung.md: a run can measure the real
-- tools against a synthetic database instead of canned results.
--
-- `data_source` says which: 'canned' (the fixtures in bench/cases.ts) or
-- 'synthetic' (seeded rows owned by the benchmark account, read through the
-- real services). Runs filed before this column are canned.
ALTER TABLE "assistant_benchmark_run" ADD COLUMN IF NOT EXISTS "data_source" text NOT NULL DEFAULT 'canned';--> statement-breakpoint

-- Every top-level row the seeder writes (an account, a meter, a document, a
-- tag it created) is registered here, so "remove the synthetic data" takes
-- back exactly what a run laid down and nothing else. Child rows (bookings,
-- readings, tax sections) go with their parent.
CREATE TABLE IF NOT EXISTS "assistant_benchmark_seed" (
  "id" serial PRIMARY KEY,
  "table_name" text NOT NULL,
  "row_id" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
