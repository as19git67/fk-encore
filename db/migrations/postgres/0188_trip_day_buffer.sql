-- The buffer day a climate normal asks for (§7.2).
--
-- Forecasts reach about a fortnight. For a trip that starts in eight
-- months there are none, and §7.2 says what takes their place: not day
-- plans — a monthly average cannot say what Tuesday will do — but
-- precautions. One of the two is "ein nicht verplanter Puffertag je
-- Etappe": a day the planner leaves empty on purpose, so a washed-out
-- morning has somewhere to go without anything else moving.
--
-- The column holds the *reason* rather than a flag, because a day that
-- is simply empty looks exactly like a day the planner failed to fill,
-- and only one of the two is worth keeping. "Im September ist dort etwa
-- jeder dritte Tag nass" is a sentence somebody can argue with; a
-- boolean is not.
--
-- NULL is every ordinary day, which is nearly all of them.
ALTER TABLE trip_plan_days
  ADD COLUMN IF NOT EXISTS buffer_reason text;
