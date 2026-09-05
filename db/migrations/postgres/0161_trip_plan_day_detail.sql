-- Trip planner: two resolutions (§4.3).
--
-- Twenty days is about sixty blocks. Nobody wants to review those in advance
-- and it would be wasted effort anyway — the weather is unknown, and after
-- three days you know better what suits you. So the trip is planned at two
-- resolutions: a scored pool per leg plus everything time-bound, immediately;
-- and concrete blocks with an order and walks, a day or two ahead.
--
-- `detailed` says which of the two a day is at. An undetailed day still has
-- its frame — its blocks with their budgets, and its fixpoints — because that
-- frame is trip-resolution information: it is what the family votes on. What
-- it does not yet have is stops.
--
-- Existing rows are detailed: every plan written before this column was one
-- where both resolutions coincided, which is what a weekend trip is anyway.

ALTER TABLE trip_plan_days
  ADD COLUMN IF NOT EXISTS detailed boolean NOT NULL DEFAULT true;
