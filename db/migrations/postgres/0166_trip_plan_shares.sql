-- Who else is on this trip (§6.2).
--
-- A plan was strictly the property of whoever created it: every query
-- filtered on owner_id, so nobody else could see it, let alone
-- contribute. §6.2 describes the opposite — everyone contributes spots,
-- votes and re-plans on the road — with exactly three rights reserved
-- for one person.
--
-- The organiser is not a row here. They are the plan's owner, which is
-- already recorded and cannot be lost by deleting a share. Everyone
-- else is a participant, and the role column exists so a future
-- hand-over ("die Rolle ist übertragbar", §6.2) has somewhere to write
-- without another migration.
CREATE TABLE trip_plan_shares (
  id serial PRIMARY KEY,
  plan_id integer NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- participant — everything except the organiser's three rights.
  role text NOT NULL DEFAULT 'participant',
  invited_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per person per trip: inviting somebody twice is the same
-- invitation, not a second one.
CREATE UNIQUE INDEX trip_plan_shares_plan_user_key
  ON trip_plan_shares (plan_id, user_id);

-- "Which trips can I see?" is asked on every list.
CREATE INDEX trip_plan_shares_user_idx ON trip_plan_shares (user_id);
