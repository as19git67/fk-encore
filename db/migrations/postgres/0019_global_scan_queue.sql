ALTER TABLE photo_scan_queue ALTER COLUMN user_id DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS uq_active_scan;--> statement-breakpoint
CREATE UNIQUE INDEX uq_active_scan_global ON photo_scan_queue (photo_id, service) WHERE status IN ('pending', 'processing') AND user_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX uq_active_scan_user ON photo_scan_queue (photo_id, service, user_id) WHERE status IN ('pending', 'processing') AND user_id IS NOT NULL;
