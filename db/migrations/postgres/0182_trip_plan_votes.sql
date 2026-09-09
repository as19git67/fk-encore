-- The pool is shared, the rating is personal (§6.1).
--
-- Everyone on a trip feeds the same pool; what differs is what each of
-- them thinks of it. This table is that difference, and the reason it
-- is a table rather than a number on trip_plan_pool: an average is the
-- wrong aggregation. A mean picks what everybody finds mediocre and
-- deletes what one person cares a great deal about — the trip nobody
-- loved. Keeping the individual answers is what makes the two
-- correctives possible (heart wishes with a quota, and a fairness
-- account); a single averaged column could support neither.
--
-- A vote belongs to a leg, not to the whole trip: the quota for heart
-- wishes is per leg (§6.1, "je Etappe"), and the same spot can matter
-- differently on the way there and on the way back.
--
-- Who votes is *either* an account or a proxy voice: §6.1 gives
-- somebody without their own login — a small child — a vote held on
-- their behalf, and the traveller rows from §3.5 are exactly those
-- people. Precisely one of the two columns is set, which the check
-- enforces rather than trusting the writer.
CREATE TABLE IF NOT EXISTS trip_plan_votes (
  id serial PRIMARY KEY,
  leg_id integer NOT NULL REFERENCES trip_plan_legs(id) ON DELETE CASCADE,
  osm_ref text NOT NULL,
  -- The account that voted …
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  -- … or the traveller whose voice somebody is holding (§3.5, §6.1).
  traveller_id integer REFERENCES trip_plan_travellers(id) ON DELETE CASCADE,
  -- want | meh | rather-not. Not an enum: the vocabulary is validated
  -- in trip-planner/votes.ts, and a new answer should not need a
  -- migration.
  value text NOT NULL DEFAULT 'meh',
  -- One of this voter's settings for this leg. The quota is checked in
  -- the service, because "two per three days" needs the leg's length.
  heart boolean NOT NULL DEFAULT false,
  -- Who cast it, which is the voter themselves except for a proxy
  -- voice. Kept so "wer hat für das Kind gestimmt" is answerable.
  cast_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_plan_votes_one_voice CHECK (
    (user_id IS NOT NULL AND traveller_id IS NULL)
    OR (user_id IS NULL AND traveller_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS trip_plan_votes_leg_idx ON trip_plan_votes (leg_id);
-- One answer per voice per spot: voting again changes the answer
-- rather than adding a second one. Two partial indexes because the
-- voice lives in one of two columns.
CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_votes_leg_user_ref_key
  ON trip_plan_votes (leg_id, user_id, osm_ref)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_votes_leg_traveller_ref_key
  ON trip_plan_votes (leg_id, traveller_id, osm_ref)
  WHERE traveller_id IS NOT NULL;
