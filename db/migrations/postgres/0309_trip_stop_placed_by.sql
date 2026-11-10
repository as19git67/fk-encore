-- Who put a stop on its day (reise-planen-und-unterwegs.md, stage 8):
-- `hand` is a person, and the stop stays where they put it; `fill` is
-- "Tag füllen", and a soft stop the day did not reach goes back to the
-- open spots once the day is over. Every stop written so far was put
-- there by somebody, so the default keeps them all where they are.
ALTER TABLE "trip_plan_stops" ADD COLUMN IF NOT EXISTS "placed_by" text NOT NULL DEFAULT 'hand';
