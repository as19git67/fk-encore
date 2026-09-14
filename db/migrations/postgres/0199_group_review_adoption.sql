-- Adopting other people's group reviews (docs/group-review-adoption.md).
--
-- In a household where only one person works through the similar-photo
-- stacks, everybody else keeps seeing every burst frame. Their review
-- should become the others' default — reversibly, and never silently.
--
-- The adoption materialises real photo_curation rows so the ~20 existing
-- "is this hidden for me" queries keep working untouched. `source` keeps
-- the provenance, so an adopted hide can be told apart from a self-made
-- one, reverted, and kept out of the anonymised consensus counters.
ALTER TABLE photo_curation
  ADD COLUMN source TEXT NOT NULL DEFAULT 'user';

-- 'user' | 'adopted'; NULL while the group is still unreviewed. Adopted
-- reviews never cascade further, so the pass needs to tell them apart.
ALTER TABLE photo_groups
  ADD COLUMN review_source TEXT;

UPDATE photo_groups SET review_source = 'user' WHERE reviewed_at IS NOT NULL;

-- Global per-user default. On, because somebody who reviews for
-- themselves never notices it: their own review always wins.
ALTER TABLE users
  ADD COLUMN adopt_group_reviews BOOLEAN NOT NULL DEFAULT TRUE;

-- Per-album override: NULL = inherit the user default, 'on', 'off'.
ALTER TABLE album_user_settings
  ADD COLUMN group_review_adoption TEXT;

-- The revert path and the compare view both ask "which of my rows are
-- adopted"; without this they would seq-scan the whole curation table.
CREATE INDEX idx_photo_curation_adopted
  ON photo_curation (user_id, photo_id)
  WHERE source = 'adopted';
