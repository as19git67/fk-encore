-- The facial-landmark backfill (0272, 0273) runs as a scan-queue service:
-- one `face_landmarks` job per photo whose faces still owe landmarks or a
-- ratio, queued on demand from Fotos › Einstellungen › Wartung.
ALTER TYPE scan_service ADD VALUE IF NOT EXISTS 'face_landmarks';
