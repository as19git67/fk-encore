-- "Not this one, and not next time either" (§5, §20.5).
--
-- Removing a spot from a day puts it back in the pool rather than in the
-- bin: that is the rule the whole replanning mechanic rests on. But a
-- spot the search keeps proposing — the wrong kind of place, a car park
-- mapped as a sight, the church nobody wants to see a fourth time — has
-- no way out today, because the row is not ours to delete: it comes back
-- from the region database on every search.
--
-- So the "no" is remembered instead. Per trip rather than per leg: a
-- place the family did not want in Lisbon is not wanted on the second
-- Lisbon day either, and a trip is the unit people think in.
CREATE TABLE IF NOT EXISTS trip_hidden_spots (
  id serial PRIMARY KEY,
  plan_id integer NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  osm_ref text NOT NULL,
  -- What it was called when it was hidden, so the list of hidden spots
  -- can name them without asking the map again — the whole point is
  -- that they no longer come back from there.
  name text,
  hidden_by integer REFERENCES users(id) ON DELETE SET NULL,
  hidden_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_hidden_spots_plan_ref_key
  ON trip_hidden_spots (plan_id, osm_ref);
