-- A stay can be pinned to its first day: it stays there whatever changes
-- before it, and the journey before it takes up the difference. Without
-- the pin a stay moves along with the chain, as before.
ALTER TABLE "trip_plan_legs" ADD COLUMN IF NOT EXISTS "start_pinned" boolean NOT NULL DEFAULT false;
