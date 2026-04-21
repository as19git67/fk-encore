-- Add 'thumbnail' to the scan_service enum so the thumbnail prewarm worker
-- can persist jobs in photo_scan_queue. The prewarm job generates the common
-- thumbnail widths up-front so the /photos/file endpoint always hits the
-- on-disk cache and never has to call sharp() on the request path.
ALTER TYPE scan_service ADD VALUE IF NOT EXISTS 'thumbnail';
