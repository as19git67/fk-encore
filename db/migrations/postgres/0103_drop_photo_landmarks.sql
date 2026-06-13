-- Migration 0103: Drop the photo_landmarks table.
--
-- Landmark detection (Grounding DINO) was retired in Epic #383 and is
-- fully superseded by the osm-admin POI matcher (photo_poi_matches). No
-- code reads or writes photo_landmarks any longer, so the table — along
-- with its indexes and the photo_id foreign key — is removed.

DROP TABLE IF EXISTS "photo_landmarks";
