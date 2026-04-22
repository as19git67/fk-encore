-- Consolidate the social-Like feature into the existing Favorite
-- (`photo_curation.status = 'favorite'`) curation state.
--
-- Rationale: for a family-photo app both are the same binary "this
-- photo is good" reaction per user per photo. Dropping the separate
-- `photo_likes` table eliminates the UX double-action and keeps one
-- consistent filter surface (the Favorite filter).
--
-- Existing likes are merged into the curation table first. We only
-- promote *visible* rows or create new ones — an existing `hidden`
-- status is preserved (the user consciously hid the photo later; that
-- decision wins over an earlier like).

INSERT INTO photo_curation (user_id, photo_id, status, updated_at)
SELECT pl.user_id, pl.photo_id, 'favorite', pl.created_at
FROM   photo_likes pl
ON CONFLICT (user_id, photo_id) DO UPDATE
   SET status = 'favorite'
   WHERE photo_curation.status = 'visible';

DROP TABLE photo_likes;

-- Rename the corresponding feed kind so existing feed_items rows (and
-- the enum label) pick up the new terminology. PostgreSQL 10+ supports
-- an in-place enum value rename; all existing rows keep their ordinal
-- and simply read as 'photo_favorited' going forward.
ALTER TYPE feed_item_kind RENAME VALUE 'photo_liked' TO 'photo_favorited';
