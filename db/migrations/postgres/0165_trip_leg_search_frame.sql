-- What a leg was searched with, so it can be searched again.
--
-- Changing the pace or who is travelling re-plans the days, and a
-- re-plan has to reproduce the leg exactly as it was set up. Two of the
-- three things that shaped it were never written down: the search
-- radius and when the day begins. Without them a re-plan would quietly
-- fall back to the defaults — a wider or narrower area than the
-- traveller chose, and a morning starting at a different hour.
--
-- Both are nullable, and null keeps meaning "the default": rows written
-- before this migration were planned with exactly that.
ALTER TABLE trip_plan_legs
  ADD COLUMN radius_m integer,
  ADD COLUMN day_starts_at integer;

COMMENT ON COLUMN trip_plan_legs.radius_m IS
  'Search radius around the anchor, in metres. Null = the planner default.';
COMMENT ON COLUMN trip_plan_legs.day_starts_at IS
  'When this leg''s days begin, in minutes past midnight. Null = the planner default.';
