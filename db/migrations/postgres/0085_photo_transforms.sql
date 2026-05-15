-- Migration 0085: AI photo transformations — non-destructive per-user edits.
--
-- Track S / Epic #384 — phase 1 of Photos AI Crop & Transformation
-- Suggestions. Original image files are never overwritten; instead, each
-- user can persist a recipe (crop, rotation, exposure, contrast, gamma,
-- black/white-point) that is applied either client-side via CSS/SVG
-- filters (detail view, editor live-preview) or server-side via sharp
-- (grid thumbnails, exports).
--
-- Two tables:
--
-- 1. photo_transform_suggestions — one row per photo, globally shared.
--    Filled by the suggestion-compute hook that runs behind the existing
--    face/landmark indexing pipeline. `payload` carries crops for every
--    supported aspect ratio plus the auto-exposure recipe.
--
-- 2. photo_transforms — at most one row per (photo, user). Absent row
--    means "show the original". Rollback is a single DELETE. The
--    `adopted_from` column tracks lineage when one user adopts another
--    user's variant. It is intentionally ON DELETE SET NULL so an
--    adopted recipe survives the source user removing theirs.
--
-- See docs/photos-ai-transforms.md and docs/photos-ai-crop-investigation.md
-- for the full design rationale.

CREATE TABLE photo_transform_suggestions (
  photo_id      INTEGER     PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  payload       JSONB       NOT NULL,
  model_version TEXT        NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE photo_transforms (
  id            SERIAL      PRIMARY KEY,
  photo_id      INTEGER     NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  user_id       INTEGER     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  source        TEXT        NOT NULL CHECK (source IN ('ai', 'user', 'adopted')),
  adopted_from  INTEGER     REFERENCES photo_transforms(id) ON DELETE SET NULL,
  crop          JSONB,
  rotation      INTEGER     NOT NULL DEFAULT 0 CHECK (rotation IN (0, 90, 180, 270)),
  exposure      REAL        NOT NULL DEFAULT 0,
  contrast      REAL        NOT NULL DEFAULT 0,
  gamma         REAL        NOT NULL DEFAULT 1,
  white_point   REAL,
  black_point   REAL,
  applied_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX photo_transforms_photo_user_uniq
  ON photo_transforms (photo_id, user_id);

CREATE INDEX photo_transforms_user_id_idx
  ON photo_transforms (user_id);
