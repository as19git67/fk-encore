-- Demo data for a fresh installation (documentation/plans/demodaten.md,
-- stage 1): an admin fills an untouched system with a synthetic household
-- and can take every row of it back again.
--
-- One row per run: who started it, with which seed and size, how far it got.
CREATE TABLE IF NOT EXISTS "demo_run" (
  "id" serial PRIMARY KEY,
  "owner_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "seed" integer NOT NULL,
  "size" text NOT NULL,
  "text_source" text NOT NULL,
  -- running | cancelling | done | failed | cancelled | removing | removed
  "status" text NOT NULL,
  "stage" text,
  "progress" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "error" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "removed_at" timestamptz
);--> statement-breakpoint

-- Every row a run writes, so "Demodaten entfernen" takes back exactly
-- that and nothing else. Rows that hang off a recorded row by foreign key
-- go with their parent and are not listed.
CREATE TABLE IF NOT EXISTS "demo_item" (
  "id" bigserial PRIMARY KEY,
  "run_id" integer NOT NULL REFERENCES "demo_run"("id") ON DELETE CASCADE,
  "table_name" text NOT NULL,
  "row_id" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_item_run_table_idx" ON "demo_item" ("run_id", "table_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_item_table_row_idx" ON "demo_item" ("table_name", "row_id");--> statement-breakpoint

-- Every file a run writes (generated PDFs, downloaded photos).
CREATE TABLE IF NOT EXISTS "demo_file" (
  "id" bigserial PRIMARY KEY,
  "run_id" integer NOT NULL REFERENCES "demo_run"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- What the generator knows about a document it made (kind, sender, date,
-- amount, tax role, matching booking), to measure the classification
-- against after the pipeline has run.
CREATE TABLE IF NOT EXISTS "demo_truth" (
  "id" bigserial PRIMARY KEY,
  "run_id" integer NOT NULL REFERENCES "demo_run"("id") ON DELETE CASCADE,
  "document_id" integer,
  "kind" text NOT NULL,
  "truth" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
