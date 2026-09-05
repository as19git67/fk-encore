-- Why a stop is on the day, and where it came from (§9.2).
--
-- A find carries a note and a link — "beste Pastéis laut Blog" — and
-- §9.2 is explicit that both survive: "Herkunft und Link bleiben
-- erhalten". They did, right up until the spot was actually planned:
-- the pool row was the only place they lived, and placing a candidate
-- into a block deletes it. The one moment the traveller acts on a find
-- was the moment its reason disappeared.
--
-- Nullable, because most stops have neither: they came out of the
-- region search, and their reasons are the scoring ones the pool
-- already shows.
ALTER TABLE trip_plan_stops ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE trip_plan_stops ADD COLUMN IF NOT EXISTS source_url text;
