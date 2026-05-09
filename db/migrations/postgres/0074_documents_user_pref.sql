-- Migration 0072: per-user JSONB preferences for the documents module.
--
-- Mirrors `finance_user_pref` (migration 0059). One row per
-- (user_id, key); JSONB value lets us add new per-user settings later
-- without further schema changes.
--
-- First consumer is the configurable "default group for new documents"
-- under key='upload_defaults':
--   { "group_id": 7 }   -- new uploads land in group 7
--   { "group_id": null } -- explicit private (= no preference set)

CREATE TABLE IF NOT EXISTS documents_user_pref (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
