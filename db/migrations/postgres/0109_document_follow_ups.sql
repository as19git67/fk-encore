-- Free-form notes on a document. Shared document metadata, independent of the
-- per-user follow-up feature (issue #750).
ALTER TABLE documents ADD COLUMN notes TEXT;

-- Per-user follow-up ("Wiedervorlage") reminders. A row snoozes a document out
-- of the user's work-item basket until follow_up_date; the daily follow-up cron
-- deletes due rows so the document re-surfaces in the basket and notifies the
-- user.
CREATE TABLE document_follow_ups (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  follow_up_date TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (document_id, user_id)
);

CREATE INDEX document_follow_ups_user_date_idx
  ON document_follow_ups (user_id, follow_up_date);
