-- Migration 0084: POI detection foundations (Epic #383).
--
-- Two new tables for the upcoming self-hosted POI pipeline:
--
--   osm_region_imports
--     Tracks which Geofabrik OSM extracts have been imported into the
--     per-region Nominatim + Overpass containers managed by the
--     `osm-admin` service. Bounding box is stored as four lat/lon
--     columns; main postgres has no PostGIS, but a simple range query
--     is sufficient for the router.
--
--   poi_references
--     One row per known POI (keyed by Wikidata QID). Holds the Commons
--     reference image URL and a DINOv2 embedding for image matching
--     against user photos. The vector column is added via raw SQL so it
--     stays out of Drizzle's typed schema (same pattern as
--     `document_embeddings` in migration 0027).
--
-- No data is inserted; both tables start empty and are filled by the
-- forthcoming osm-admin / poi-detection workers.

CREATE TABLE osm_region_imports (
  slug              TEXT PRIMARY KEY,
  geofabrik_url     TEXT NOT NULL,
  pbf_size_mb       INTEGER,
  postgres_db       TEXT NOT NULL,
  bbox_min_lat      DOUBLE PRECISION NOT NULL,
  bbox_min_lon      DOUBLE PRECISION NOT NULL,
  bbox_max_lat      DOUBLE PRECISION NOT NULL,
  bbox_max_lon      DOUBLE PRECISION NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending_approval',
  last_used_at      TIMESTAMPTZ,
  imported_at       TIMESTAMPTZ,
  replication_seq   TEXT,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX osm_region_imports_status_idx
  ON osm_region_imports (status);--> statement-breakpoint

CREATE INDEX osm_region_imports_bbox_idx
  ON osm_region_imports (bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon);--> statement-breakpoint

CREATE TABLE poi_references (
  qid                TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  name_de            TEXT,
  wikipedia_url      TEXT,
  commons_image_url  TEXT,
  embedding          VECTOR(768),
  embedded_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);--> statement-breakpoint

-- HNSW index for cosine similarity, same operator class as
-- document_embeddings. Partial: only rows with an embedding ever land
-- in the index, so freshly-discovered POIs without a cached embedding
-- don't bloat it.
CREATE INDEX poi_references_embedding_hnsw
  ON poi_references
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
