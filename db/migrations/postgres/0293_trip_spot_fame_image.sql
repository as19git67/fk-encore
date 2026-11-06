-- The picture on a candidate's card (candidate ranking plan, stage 2):
-- Wikipedia's main image, else Wikidata's P18, else a photograph taken
-- within 60 m, with its thumbnail, author and licence.
ALTER TABLE trip_spot_fame ADD COLUMN IF NOT EXISTS image JSONB;
-- Places looked up before pictures were part of the lookup get one on
-- the next background refill.
UPDATE trip_spot_fame SET fetched_at = NULL WHERE image IS NULL;
