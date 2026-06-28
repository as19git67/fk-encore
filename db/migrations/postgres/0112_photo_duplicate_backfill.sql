CREATE TABLE IF NOT EXISTS photo_duplicate_backfill_state (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0,
  processing_at timestamptz,
  next_attempt_at timestamptz,
  completed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
