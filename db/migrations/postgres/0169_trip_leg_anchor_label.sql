-- What the anchor is called (§4.2).
--
-- The anchor is the hotel, the campsite, or the friends' address: the
-- point every day of the leg starts and ends at. The leg's `title` is
-- something else — the city, "München" — and until now one column had
-- to be both. Picking a hotel on the map therefore named the whole trip
-- after the hotel, and the day screen could not say where the day
-- begins, because the only name it had was the city's.
--
-- Nullable: a leg anchored on a city centre has no address to give, and
-- inventing one would be a claim the data does not support (§15.3).
ALTER TABLE trip_plan_legs ADD COLUMN IF NOT EXISTS anchor_label text;

-- When the group reaches this city (§4.2).
--
-- A transfer's arrival shortened the first day of a leg — and only
-- until the next re-plan, because the shortening lived in the request
-- and nowhere else. Every settings change quietly handed the morning
-- back. Stored as minutes past midnight, like `day_starts_at`, and
-- distinct from it: `day_starts_at` is when *every* day of the leg
-- begins, this is when the first one does.
--
-- It also applies to the first leg of a trip now. Nobody transfers into
-- the start of a holiday, but they do arrive there, and a day one that
-- starts at 09:00 for a group landing at 14:00 is a morning the plan
-- invented.
ALTER TABLE trip_plan_legs ADD COLUMN IF NOT EXISTS arrive_minutes integer;
