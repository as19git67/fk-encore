-- A note on a journey (reise-planen-und-unterwegs.md, "the journey
-- sheet"): the flight number, the seat. A journey is a row of its own
-- only while both its times are known, so the note lives on a stay it
-- touches: `departure_note` is the journey that leaves this stay, and
-- `arrival_note` the way there from home, read on the first stay only.
ALTER TABLE "trip_plan_legs" ADD COLUMN IF NOT EXISTS "departure_note" text;
ALTER TABLE "trip_plan_legs" ADD COLUMN IF NOT EXISTS "arrival_note" text;
