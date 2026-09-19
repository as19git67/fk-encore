-- A day-trip suggestion that was waved away (§4.6).
--
-- The planner may say once that Florence is an hour from the village
-- whose pool does not carry four days. Saying it again every time the
-- screen opens is nagging, and §6.4 and §7.1 are both explicit that a
-- "no" is remembered rather than forgotten.
--
-- Keyed on the leg rather than on the plan: the same trip may be short
-- of things to do in one place and full in the next, and "no thanks"
-- was said about one of them. The leg row survives a re-plan — only
-- its days and its pool are rewritten — so the answer survives with it.
--
-- The target key is the area's OSM reference where a boundary named
-- it, and its rounded position where the destination is a cluster of
-- spots that no municipality is. Both are stable across re-planning,
-- which a row id would not be.
CREATE TABLE trip_plan_day_trip_dismissals (
  id            SERIAL PRIMARY KEY,
  leg_id        INTEGER NOT NULL REFERENCES trip_plan_legs(id) ON DELETE CASCADE,
  target_key    TEXT NOT NULL,
  name          TEXT,
  dismissed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Said twice is said once: a second "no" about the same place updates
-- nothing rather than piling up rows.
CREATE UNIQUE INDEX trip_day_trip_dismissals_leg_target_key
  ON trip_plan_day_trip_dismissals (leg_id, target_key);
