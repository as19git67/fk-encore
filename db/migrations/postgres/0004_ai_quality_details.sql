-- Migration 0004: Store per-component quality scores alongside the composite score
ALTER TABLE photos ADD COLUMN ai_quality_details jsonb;
