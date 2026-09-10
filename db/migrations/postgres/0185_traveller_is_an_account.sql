-- A traveller who also has a login (§3.5, §6.2).
--
-- The two lists on a trip answer different questions: `trip_plan_shares`
-- is who may *plan* it, `trip_plan_travellers` who is *on* it. Keeping
-- them apart is right — a four-year-old has no account and still
-- decides how long the afternoon may be — but it left a gap for the
-- commonest person of all: an adult who does both. They had to be
-- entered twice, once by e-mail as a planner and once by hand as a
-- traveller, and the second entry knew nothing about the first.
--
-- This column closes that: a traveller row may say "this is that
-- account". The suggestion list can then offer the trip's planners
-- alongside the household, and one tap says they are coming.
--
-- ON DELETE SET NULL rather than CASCADE: if the account goes, the
-- person was still on the trip, and the row keeps their name.
ALTER TABLE trip_plan_travellers
  ADD COLUMN IF NOT EXISTS added_for_user_id integer
  REFERENCES users(id) ON DELETE SET NULL;

-- The same account added twice is the same statement twice. Partial,
-- because most travellers have no account at all.
CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_travellers_plan_user_key
  ON trip_plan_travellers (plan_id, added_for_user_id)
  WHERE added_for_user_id IS NOT NULL;
