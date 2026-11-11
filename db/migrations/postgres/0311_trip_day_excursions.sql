-- Day trips with a time window inside a day (`trip-planner/excursions.ts`):
-- where to, the hour the group leaves the quarters and the hour it
-- starts back. A day may hold several; each is a block of its own.
ALTER TABLE "trip_plan_days" ADD COLUMN IF NOT EXISTS "excursions" jsonb NOT NULL DEFAULT '[]'::jsonb;
