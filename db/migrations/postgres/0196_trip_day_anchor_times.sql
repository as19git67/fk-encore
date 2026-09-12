-- The two times of a day trip (§4.5): when you set off, and when you
-- start back.
--
-- The travel estimate is a guess and the traveller's own times are
-- facts. An hour and a half to Pisa came out of the planner as four and
-- a quarter, because it knew one speed per mode and used the city one
-- for sixty kilometres. That arithmetic is fixed, but it is still an
-- estimate — and somebody who says "wir fahren um neun los und um fünf
-- zurück" has answered better than any estimate can.
--
-- Both nullable and independent: naming only the return is a perfectly
-- ordinary thing to know first.
ALTER TABLE trip_plan_days
  -- When the group leaves the quarters, minutes past midnight.
  ADD COLUMN anchor_depart_minutes INTEGER,
  -- When they start back *from the destination* — so the day at the
  -- destination ends here, and the drive home costs the day nothing
  -- more.
  ADD COLUMN anchor_return_minutes INTEGER;
