-- Orientation variants: portrait and landscape of the same motif
-- (.claude/plans/orientierungs-varianten.md).
--
-- A similarity group that holds both a portrait and a landscape frame taken
-- within two minutes of each other is a "format group": every view shows only
-- the side that matches the screen orientation, the other side sits one tap
-- away. Membership is computed at read time from what the group already
-- knows (orientation, visibility, taken_at); nothing is written to
-- photo_curation and no counter changes.
--
-- 'auto' (default, computed) | 'off' (user said "not the same motif": the
-- group never forms a format group) | NULL = never looked at, same as 'auto'.
ALTER TABLE photo_groups
  ADD COLUMN orientation_variants TEXT;

-- Global per-user switch under Photos › Settings. On by default; off gives
-- back today's behaviour, both sides next to each other everywhere.
ALTER TABLE users
  ADD COLUMN collapse_orientation_variants BOOLEAN NOT NULL DEFAULT TRUE;
