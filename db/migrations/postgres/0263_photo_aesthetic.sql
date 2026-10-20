-- Nightly aesthetic scoring (documentation/plans/foto-aesthetik.md, stage 3).
--
-- `aesthetic_model` names the scorer whose value sits in
-- ai_quality_details.clip_aesthetics: NULL for the zero-shot CLIP signal,
-- 'qalign_v1' once the nightly job has scored the photo, and
-- 'qalign_v1:failed' for a photo the scorer cannot read (missing file,
-- undecodable image), so it is not retried every night. The backfill
-- endpoint sets it back to NULL to have photos scored again.
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "aesthetic_model" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photos_aesthetic_model_idx" ON "photos" ("aesthetic_model");
--> statement-breakpoint
-- One row: whether the job runs, and the local time window it may use the GPU in.
CREATE TABLE IF NOT EXISTS "photo_aesthetic_settings" (
  "id" integer PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "enabled" boolean NOT NULL DEFAULT false,
  "window_start" text NOT NULL DEFAULT '01:00',
  "window_end" text NOT NULL DEFAULT '06:00',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "photo_aesthetic_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- One row per night (or per manual start). `gpu_returned` stays false until
-- the GPU is back with the llm-service; a run that ended without it is
-- retried by the next tick, so a failed hand-back never strands the card.
CREATE TABLE IF NOT EXISTS "photo_aesthetic_run" (
  "id" serial PRIMARY KEY,
  "trigger" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "phase" text,
  "model" text,
  "backlog" integer NOT NULL DEFAULT 0,
  "scored" integer NOT NULL DEFAULT 0,
  "failed" integer NOT NULL DEFAULT 0,
  "remaining" integer,
  "ended_reason" text,
  "error" text,
  "gpu_returned" boolean NOT NULL DEFAULT false,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photo_aesthetic_run_by_start" ON "photo_aesthetic_run" ("started_at");
