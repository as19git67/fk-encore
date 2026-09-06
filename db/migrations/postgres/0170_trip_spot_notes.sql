-- What a person has to say about one spot (§9.2, §10.4).
--
-- Notes and a source link already existed, but only as provenance
-- copied off a find: whoever saved the place got to say why, and
-- nobody could add a word afterwards. "Karten mitnehmen", "Eingang um
-- die Ecke", "Tickets vorher kaufen" are the things that decide how a
-- morning goes, and they arrive after the planning, not during it.
--
-- Keyed on the leg and the OSM reference rather than on the stop row,
-- because the stop row is not durable: every re-plan deletes the day's
-- stops and writes them again, so a note hanging off the row would
-- last until the next settings change. The pair (leg, place) is the
-- thing a person means, and it holds whether the place currently sits
-- in the pool, on a day, or nowhere.
CREATE TABLE IF NOT EXISTS trip_spot_notes (
  id serial PRIMARY KEY,
  leg_id integer NOT NULL REFERENCES trip_plan_legs(id) ON DELETE CASCADE,
  osm_ref text NOT NULL,
  -- What the travellers call it. OpenStreetMap's name stays in `name`
  -- on the stop: renaming a place here is the group's shorthand ("das
  -- Museum mit dem Dachgarten"), not a correction of the map.
  title text,
  note text,
  -- One link the group keeps with the spot — the official page, the
  -- booking, the blog post it came from.
  url text,
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_spot_notes_leg_ref_key
  ON trip_spot_notes (leg_id, osm_ref);

-- The name on the sign, when it is not the name on the screen (§10.4).
--
-- Spots are named readably now — a place in Tokyo comes back as
-- "Tokioter Nationalmuseum" rather than 東京国立博物館. That is the
-- right name to plan with and the wrong one to stand in front of the
-- building with, so the local one is kept beside it instead of being
-- dropped. Null whenever the readable name *is* the local one, which
-- is most of Europe: a second identical line would be noise.
ALTER TABLE trip_plan_stops ADD COLUMN IF NOT EXISTS local_name text;
ALTER TABLE trip_plan_pool ADD COLUMN IF NOT EXISTS local_name text;

-- The Wikipedia article, where OpenStreetMap knows of one.
--
-- The `wikipedia` tag has been read since the first day of the planner
-- and only ever counted towards the prominence score: a place either
-- had an article or it did not, and the article itself was thrown
-- away. Stored as the finished URL, built once in `spot-links.ts`,
-- because the pool, the day and the search must not each assemble
-- their own.
ALTER TABLE trip_plan_stops ADD COLUMN IF NOT EXISTS wikipedia_url text;
ALTER TABLE trip_plan_pool ADD COLUMN IF NOT EXISTS wikipedia_url text;
