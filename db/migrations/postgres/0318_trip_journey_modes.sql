-- How a journey travels while its times are still open. A journey is a
-- row of its own only with both times, so until then its mode lives on
-- a stay it touches, like its note (0308): `departure_mode` is the
-- journey that leaves this stay, `arrival_mode` the way there from home,
-- read on the first stay only.
ALTER TABLE "trip_plan_legs" ADD COLUMN IF NOT EXISTS "departure_mode" text;
ALTER TABLE "trip_plan_legs" ADD COLUMN IF NOT EXISTS "arrival_mode" text;
