-- The highlights of a stay (ideas plan, stage 2): the places the open
-- data knows best around it, ordered by the local model in the
-- background. Nothing here is part of the trip; it is the list the
-- travellers pick from, kept so the model is asked once per stay and
-- not once per screen.
CREATE TABLE IF NOT EXISTS trip_leg_highlights (
  leg_id INTEGER PRIMARY KEY REFERENCES trip_plan_legs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  signature JSONB,
  entries JSONB,
  context JSONB,
  picks JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS trip_leg_highlights_status_idx ON trip_leg_highlights (status, requested_at);
