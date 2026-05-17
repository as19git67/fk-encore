-- Migration 0087: POI matches per photo (Epic #383).
--
-- Adds the table that ties a photo to the POIs it likely depicts, plus
-- the `poi_detection` scan service so the existing scan-queue plumbing
-- can drive the upcoming POI matcher. The old `photo_landmarks` table
-- and the `landmark` scan service stay around for now; they'll be
-- retired in a follow-up cleanup slice once the new pipeline is fully
-- in production.
--
-- The table is keyed by (photo_id, qid) so re-running the matcher on
-- the same photo is idempotent — the unique constraint covers the
-- "exactly one row per (photo, POI)" case the matcher upserts.

ALTER TYPE scan_service ADD VALUE IF NOT EXISTS 'poi_detection';--> statement-breakpoint

CREATE TABLE photo_poi_matches (
  id            BIGSERIAL PRIMARY KEY,
  photo_id      INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  -- Wikidata QID (`Q5074`, …). Optional: an OSM-only match without a
  -- wikidata tag has osm_ref set and qid NULL.
  qid           TEXT,
  -- `node:12345`, `way:67890`, `relation:42` — the OSM element that
  -- contributed to this match. Always populated.
  osm_ref       TEXT NOT NULL,
  name          TEXT NOT NULL,
  name_de       TEXT,
  -- Crow-flies distance between the photo's GPS and the POI centroid.
  distance_m    REAL,
  -- Heading agreement, 0..1: 1 = photo's EXIF heading points straight
  -- at the POI; 0 = away. Null when no EXIF heading is available.
  heading_match REAL,
  -- Final score, 0..1 — sort by this desc to pick the top match.
  match_score   REAL NOT NULL,
  -- True when the top-1 and top-2 are within the configured margin —
  -- the UI shows them all and refuses to claim a single winner.
  ambiguous     BOOLEAN NOT NULL DEFAULT false,
  -- Which signal produced the candidate. `osm` = pure Overpass tag
  -- match. `wikidata` = SPARQL `wikibase:around` enrichment. `both` =
  -- OSM with a wikidata tag.
  source        TEXT NOT NULL,
  -- Region slug the candidate came from (for diagnostics).
  region_slug   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);--> statement-breakpoint

-- One match row per (photo, POI). When qid is null we fall back to
-- osm_ref so two pure-OSM matches against the same element collapse
-- into one row on re-scan.
CREATE UNIQUE INDEX photo_poi_matches_photo_target_idx
  ON photo_poi_matches (photo_id, COALESCE(qid, osm_ref));--> statement-breakpoint

CREATE INDEX photo_poi_matches_photo_id_idx
  ON photo_poi_matches (photo_id);--> statement-breakpoint

CREATE INDEX photo_poi_matches_qid_idx
  ON photo_poi_matches (qid)
  WHERE qid IS NOT NULL;--> statement-breakpoint

-- Sort by score desc within a photo (for the photo-detail view).
CREATE INDEX photo_poi_matches_photo_score_idx
  ON photo_poi_matches (photo_id, match_score DESC);
