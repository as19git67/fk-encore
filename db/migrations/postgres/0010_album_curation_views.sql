-- Performance index for aggregating curation stats across album participants
CREATE INDEX IF NOT EXISTS idx_photo_curation_photo_status ON photo_curation(photo_id, status);
