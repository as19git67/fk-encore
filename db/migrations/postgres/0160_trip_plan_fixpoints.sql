-- Trip planner: hard clock times, the frame of a day (§4.4).
--
-- Blocks stay relative and coarse; a fixpoint is absolute and carries a real
-- time. Two kinds, and the difference is why this is one column rather than a
-- comment: after an `appointment` you are back and the day goes on, after a
-- `departure` you are gone and nothing follows it. Treating a last train like
-- a booked tour plans an evening behind a train that has already left.
--
-- Times are minutes past midnight, local to wherever the leg is. No timezone,
-- because a fixpoint is "the 18:40 train", not an instant on a global clock —
-- and the planner must give the same answer offline on the device.
--
-- travel_minutes is the way there, estimated by the caller; buffer_minutes is
-- the margin in front of it. The buffer is negotiable but never zero: missing
-- a train costs more than a skipped spot.

CREATE TABLE IF NOT EXISTS trip_plan_fixpoints (
  id              serial PRIMARY KEY,
  day_id          integer NOT NULL REFERENCES trip_plan_days(id) ON DELETE CASCADE,
  -- appointment | departure
  kind            text NOT NULL DEFAULT 'appointment',
  label           text NOT NULL,
  -- Minutes past midnight. 18:40 is 1120.
  start_minutes   integer NOT NULL,
  -- How long it occupies. Zero for a departure — a train leaving is an instant.
  duration_minutes integer NOT NULL DEFAULT 0,
  travel_minutes  integer NOT NULL DEFAULT 0,
  buffer_minutes  integer NOT NULL DEFAULT 20,
  -- Where it happens, when that is known. Null for "somewhere in town".
  lat             double precision,
  lon             double precision,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_plan_fixpoints_day_idx
  ON trip_plan_fixpoints (day_id, start_minutes);
