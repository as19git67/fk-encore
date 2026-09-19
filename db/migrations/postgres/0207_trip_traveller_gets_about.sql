-- How a traveller gets about (§3.5).
--
-- The group has carried two things about its people: how old they are,
-- which is derived from a birth date, and whether "mehr Zeit einplanen"
-- is set, which a person states about themselves. Both scale a day —
-- shorter blocks, more pauses.
--
-- Neither can say the one thing a *route* has to hear (§4.7). A way
-- that climbs six hundred metres is not a slower day out for somebody
-- in a wheelchair or pushing a pram; it is not a day out. That is not a
-- factor, it is an exclusion, and it needs a fact the group did not
-- hold.
--
-- Three values, and the shortness is the point: a vocabulary earns an
-- entry by what the planner does with it, and the planner tells "on
-- foot" from "on wheels" and no finer. Wheelchair and pram are two
-- entries only so that a family with a pram is not asked to tick a box
-- that says wheelchair; the plan treats them alike and says so.
--
-- Set by a person, never derived — not from an age, not from a
-- relationship. The default is the ordinary answer, so no existing
-- trip changes.
ALTER TABLE trip_plan_travellers
  ADD COLUMN gets_about TEXT NOT NULL DEFAULT 'foot';

ALTER TABLE trip_plan_travellers
  ADD CONSTRAINT trip_plan_travellers_gets_about_check
  CHECK (gets_about IN ('foot', 'wheelchair', 'pram'));
