-- Migration 0094: resolve similar-photo groups that can no longer be reviewed.
--
-- A group needs at least two *visible* members to be reviewable — once all but
-- one member has been hidden (photo_curation.status = 'hidden') there is
-- nothing left to compare. Going forward, hiding a photo auto-marks such a
-- group reviewed, but groups that shrank before that logic existed (or whose
-- member was hard-deleted, cascading the membership away) stayed unreviewed
-- forever, with no badge to ever re-open them. Mark every such lingering group
-- reviewed now so it leaves the review queue.
--
-- Curation is per-user and a group belongs to one user (photo_groups.user_id),
-- so the visible-member count is taken against that owner's curation rows.

UPDATE photo_groups g
SET reviewed_at = NOW()
WHERE g.reviewed_at IS NULL
  AND (
    SELECT COUNT(*)
    FROM photo_group_members m
    LEFT JOIN photo_curation c
      ON c.photo_id = m.photo_id AND c.user_id = g.user_id
    WHERE m.group_id = g.id
      AND c.status IS DISTINCT FROM 'hidden'
  ) < 2;
