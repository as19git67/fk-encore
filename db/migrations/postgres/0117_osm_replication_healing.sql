ALTER TABLE osm_region_imports
  ADD COLUMN replication_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN replication_last_success_at TIMESTAMPTZ,
  ADD COLUMN replication_failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN replication_next_retry_at TIMESTAMPTZ;

CREATE INDEX idx_osm_region_imports_replication_healing
  ON osm_region_imports (replication_next_retry_at)
  WHERE status IN ('ready_running', 'ready_stopped');
