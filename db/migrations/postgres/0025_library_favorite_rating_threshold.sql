-- Per-library threshold for auto-favouriting photos whose XMP:Rating meets or
-- exceeds the given star count. 0 disables the behaviour (the default, so
-- existing libraries keep their current semantics).
ALTER TABLE photo_libraries
  ADD COLUMN favorite_rating_threshold INTEGER NOT NULL DEFAULT 0;
