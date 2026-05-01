-- Add per-user push notification preferences.
-- Stored as a JSONB object mapping FeedItemKind → boolean.
-- Absent keys default to true (enabled). Setting a key to false disables that type.
ALTER TABLE users
  ADD COLUMN notification_prefs JSONB NOT NULL DEFAULT '{}'::JSONB;
