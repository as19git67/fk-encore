-- Idle OSM regions are removed after a configurable time (osm-admin/retention.ts).
--
-- One row: whether the sweep runs, and after how many days without use a
-- region goes. Removing a region drops its PostGIS database; the geo
-- service then clears the extract it no longer needs, and the routing
-- container rebuilds its tiles without it.
CREATE TABLE IF NOT EXISTS "osm_region_retention_settings" (
  "id" integer PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "enabled" boolean NOT NULL DEFAULT true,
  "idle_days" integer NOT NULL DEFAULT 180,
  "last_run_at" timestamp with time zone,
  "last_removed" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "osm_region_retention_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- Until now `last_used_at` was diagnostic only, bumped by some lookups and
-- by every replication refresh, and missing for most trip-planner use. It
-- decides now, so the count starts here: every region gets the full
-- period before the sweep may touch it.
UPDATE "osm_region_imports" SET "last_used_at" = now();
