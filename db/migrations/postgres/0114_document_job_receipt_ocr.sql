-- Extend the document_job_service enum so the scan-worker queue can hold
-- receipt_ocr jobs. IF NOT EXISTS is supported in PostgreSQL 9.3+ and
-- makes this idempotent.
ALTER TYPE document_job_service ADD VALUE IF NOT EXISTS 'receipt_ocr';
