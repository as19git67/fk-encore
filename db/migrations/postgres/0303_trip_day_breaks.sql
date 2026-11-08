-- A break on a day of ideas (ideas plan, stage 4): "Mittag", "Kaffee",
-- a label and minutes with no venue, at a place in the day's line.
-- Kept beside the day rather than as a stop: a break has no place on
-- the map, and nothing that reads stops (the pool, the vote, the
-- geofence) should ever meet one.
ALTER TABLE trip_plan_days ADD COLUMN breaks jsonb NOT NULL DEFAULT '[]'::jsonb;
