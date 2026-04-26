-- Migration 0058: persistent state for the local-cron scheduler.
--
-- Per-job row keyed by the job name passed to schedule(...). Stored
-- separately from the in-memory ScheduledJob entries so we survive
-- container restarts:
--   * `enabled`           — pause/resume toggle from the admin UI
--   * `last_run_at`       — start of the most recent run
--   * `last_status`       — outcome (`ok` / `error`)
--   * `last_duration_ms`  — runtime of the most recent run
--   * `last_error`        — error message when last_status='error'
--   * `run_count`         — total successful runs (cumulative)
--   * `error_count`       — total failed runs (cumulative)
--
-- The in-process timers are still the source of truth for *when* a job
-- fires; this table only persists run history + the enabled flag.
-- A fresh row is upserted on demand the first time a job either runs
-- or gets toggled, so deploying a new schedule does not require a
-- separate seed step.

CREATE TABLE IF NOT EXISTS scheduled_job_state (
  name              text PRIMARY KEY,
  enabled           boolean NOT NULL DEFAULT true,
  last_run_at       timestamptz,
  last_status       text,
  last_duration_ms  integer,
  last_error        text,
  run_count         integer NOT NULL DEFAULT 0,
  error_count       integer NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
