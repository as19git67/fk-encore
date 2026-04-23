-- Feed kind for "a participant left a shared album" so the owner gets a
-- persistent timeline entry, not just a live realtime ping.
--
-- PostgreSQL 12+ supports ADD VALUE inside a transaction when the enum
-- was created in an earlier transaction — which is the case here, since
-- feed_item_kind was introduced in migration 0038. No backfill needed:
-- no historical rows carry this kind.

ALTER TYPE feed_item_kind ADD VALUE IF NOT EXISTS 'album_left';
