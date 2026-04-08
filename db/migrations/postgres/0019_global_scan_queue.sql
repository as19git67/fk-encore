ALTER TABLE photo_scan_queue ALTER COLUMN user_id DROP NOT NULL;--> statement-breakpoint
DELETE FROM photo_scan_queue a USING photo_scan_queue b WHERE a.service IN ('face_detection', 'embedding', 'landmark', 'quality', 'geocoding') AND b.service = a.service AND b.photo_id = a.photo_id AND a.id < b.id;--> statement-breakpoint
UPDATE photo_scan_queue SET user_id = NULL WHERE service IN ('face_detection', 'embedding', 'landmark', 'quality', 'geocoding');--> statement-breakpoint
DROP INDEX IF EXISTS uq_active_scan;--> statement-breakpoint
CREATE UNIQUE INDEX uq_active_scan_global ON photo_scan_queue (photo_id, service) WHERE status IN ('pending', 'processing') AND user_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX uq_active_scan_user ON photo_scan_queue (photo_id, service, user_id) WHERE status IN ('pending', 'processing') AND user_id IS NOT NULL;
