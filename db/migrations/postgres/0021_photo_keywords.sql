-- Persist IPTC Keywords / XMP dc:subject as photo tags (issue #129).
--
-- Tags are imported from IPTC on upload and can be searched. A GIN index
-- supports fast array-containment queries used by the keyword search.
ALTER TABLE photos ADD COLUMN keywords TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_photos_keywords ON photos USING GIN (keywords);
