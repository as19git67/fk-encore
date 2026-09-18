-- A spot with an extent (§4.7).
--
-- Every spot was a point: walk to it, stay, walk on from where you
-- stand. A route — the Ponale road above a lake, a ridge path — starts
-- in one place and finishes in another, and the next walk of the day
-- starts where it ends. A point cannot say so, and a day rewalked from
-- the start of a ten-kilometre way charged the afternoon a leg nobody
-- makes.
--
-- The extent is one JSON value: the end, and where known the length
-- and the ascent in metres. Null is the ordinary point, which is every
-- spot the region import knows; a route enters by hand, as a find.
ALTER TABLE trip_plan_pool ADD COLUMN extent JSONB;
ALTER TABLE trip_plan_stops ADD COLUMN extent JSONB;
