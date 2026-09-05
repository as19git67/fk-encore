-- Trip planner: where the travellers actually were (§6.4).
--
-- What the device works out — a dwell, a photo the POI matcher tied to a place,
-- a payment in the window — arrives here as one row per visit. Only the event
-- "X was at Y between these two times" ever leaves the phone: the concept keeps
-- the position on the device (§7.1), and a table of coordinates over time is a
-- different product than a travel diary.
--
-- Per **person**, not per group. After a split the day divides, and the history
-- would otherwise not know who saw the temple. Visibility to the rest of the
-- trip is a separate question (§15.4) and lives above this table.
--
-- `sources` is the list of signals that fired, not a boolean: one signal is a
-- suggestion the traveller answers, two set the status quietly, and keeping the
-- list means the row can say why it believes what it believes.
--
-- `stop_id` is null for an **unplanned** stay — "13:40–14:20 wart ihr hier, als
-- Stopp übernehmen?" is the more valuable half of §6.4, because it records the
-- day that happened rather than ticking off the one that was planned.

CREATE TABLE IF NOT EXISTS trip_plan_visits (
  id          serial PRIMARY KEY,
  plan_id     integer NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  -- Whose visit. Per person, so a split still adds up.
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The planned stop this confirms, when it confirms one.
  stop_id     integer REFERENCES trip_plan_stops(id) ON DELETE SET NULL,
  -- Where it was, independent of the plan: a stop can be moved or deleted and
  -- the visit still happened.
  osm_ref     text,
  name        text,
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  arrived_at  timestamptz NOT NULL,
  left_at     timestamptz,
  -- Which signals fired: dwell | photo | payment | manual.
  sources     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- False while the traveller has only been asked ("wart ihr hier?").
  confirmed   boolean NOT NULL DEFAULT false,
  -- Set when the traveller answered no, so the same stay is not offered again.
  dismissed   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_plan_visits_plan_idx
  ON trip_plan_visits (plan_id, arrived_at);
CREATE INDEX IF NOT EXISTS trip_plan_visits_stop_idx
  ON trip_plan_visits (stop_id);

-- One visit per person, place and arrival: a device that reports the same stay
-- twice (a re-sync, a retried request) must not double the diary.
--
-- NULLS NOT DISTINCT rather than coalesce(osm_ref, ''): two unplanned stays by
-- the same person at the same instant are the same stay, and an expression
-- index would leave ON CONFLICT with no column list it can infer from.
CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_visits_person_place_arrival_key
  ON trip_plan_visits (plan_id, user_id, osm_ref, arrived_at) NULLS NOT DISTINCT;
