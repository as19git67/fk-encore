-- Migration 0003: AI quality score for photos

-- Extend the scan_service enum with a new 'quality' service type.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction on older Postgres
-- versions, but Drizzle runs each migration in its own transaction and
-- Postgres 12+ supports it fine.  Use IF NOT EXISTS for idempotency.
ALTER TYPE scan_service ADD VALUE IF NOT EXISTS 'quality';

-- Store the AI-computed quality score (0.0 = worst, 1.0 = best) on each photo.
-- NULL means the quality scan has not yet run for this photo.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS ai_quality_score REAL;
