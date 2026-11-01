-- Demo data, stage 4 (documentation/plans/demodaten.md): the photos a run
-- chose, with where each came from and under which licence, so a removed
-- run can be loaded again with the same set and every photo's licence stays
-- traceable. Rows stay when the run is removed; they go with the run row.
CREATE TABLE IF NOT EXISTS "demo_photo" (
  "id" bigserial PRIMARY KEY,
  "run_id" integer NOT NULL REFERENCES "demo_run"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "topic" text NOT NULL,
  -- openverse | drawn
  "source" text NOT NULL,
  "openverse_id" text,
  "title" text,
  "creator" text,
  "license" text,
  "license_version" text,
  "image_url" text,
  "landing_url" text,
  "file_name" text NOT NULL,
  "photo_id" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "demo_photo_run_idx" ON "demo_photo" ("run_id", "position");
