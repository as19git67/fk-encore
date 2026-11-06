-- What open data says about one place (candidate ranking plan, stage 1):
-- Wikipedia page views, language editions, Commons pictures and a
-- Wikivoyage listing. Per place, keyed by the OSM reference, valid for
-- 90 days; a row without fetched_at waits for the background refill.
CREATE TABLE IF NOT EXISTS trip_spot_fame (
  osm_ref TEXT PRIMARY KEY,
  name TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  wikidata_qid TEXT,
  wikipedia TEXT,
  pageviews INTEGER,
  languages INTEGER,
  commons_category TEXT,
  commons_files INTEGER,
  wikivoyage TEXT,
  wikivoyage_page TEXT,
  fetched_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_spot_fame_pending_idx ON trip_spot_fame (requested_at) WHERE fetched_at IS NULL;
