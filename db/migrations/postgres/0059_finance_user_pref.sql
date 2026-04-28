-- Migration 0059: per-user JSONB preferences for the finance module.
--
-- One row per (user_id, key). The first consumer is the configurable
-- finance-overview landing page which stores the user's section
-- groupings under key='overview':
--   { "sections": [
--       { "name": "Täglich", "account_ids": [12, 7] },
--       { "name": "Sparen",  "account_ids": [9] }
--     ] }
--
-- Keeping the value JSONB lets us iterate on the overview shape (and
-- add other per-user settings later) without further schema changes.

CREATE TABLE IF NOT EXISTS finance_user_pref (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
