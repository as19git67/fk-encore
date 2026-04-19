/**
 * Shared in-memory state for the backup/maintenance flow.
 *
 * All Encore services run in the same Node process, so a simple module-level
 * variable is sufficient for coordinating maintenance mode across services.
 *
 * Phase machine (driven by backup/api.ts):
 *
 *   idle
 *     │ /internal/backup/start arrives
 *     ▼
 *   draining   ── pauseWorkers() drains in-flight scan jobs
 *     │
 *     ▼
 *   dumping    ── pg_backup_start() + pg_dump() run in the background
 *     │
 *     ▼
 *   ready      ── host may now take a filesystem snapshot; /stop acknowledges
 *     │
 *     ▼
 *   stopping   ── pg_backup_stop() + resumeWorkers(); transient
 *     │
 *     ▼
 *   idle
 *
 * Any prep step can transition to `failed` instead. The `failed` state
 * retains `label` + `error` for the host-side polling script to observe
 * before the next /start (or /stop) resets to idle.
 *
 * `active` is the boolean that drives the maintenance-mode middleware and
 * the raw-endpoint opt-outs. It is true in draining / dumping / ready /
 * stopping, and false in idle / failed — so the app becomes responsive
 * again as soon as a failure is acknowledged internally, without waiting
 * for the host script.
 */

export type BackupPhase =
  | "idle"
  | "draining"
  | "dumping"
  | "ready"
  | "stopping"
  | "failed";

export interface BackupState {
  active: boolean;
  label: string | null;
  startedAt: Date | null;
  phase: BackupPhase;
  /** Populated in `failed`; cleared on the next /start or /stop. */
  error: string | null;
  /** Path to the pg_dump file; known as soon as the label is accepted. */
  dumpFile: string | null;
  /** Whether pg_backup_start() has been called and therefore must be
   *  matched by pg_backup_stop() on cleanup. */
  pgBackupStarted: boolean;
  /** Timer that force-stops a stuck backup if /internal/backup/stop never arrives. */
  autoStopTimer: ReturnType<typeof setTimeout> | null;
}

const state: BackupState = {
  active: false,
  label: null,
  startedAt: null,
  phase: "idle",
  error: null,
  dumpFile: null,
  pgBackupStarted: false,
  autoStopTimer: null,
};

export function isInBackupMode(): boolean {
  return state.active;
}

export function getBackupState(): Readonly<BackupState> {
  return state;
}

export function setBackupActive(
  label: string,
  autoStopTimer: ReturnType<typeof setTimeout>,
  dumpFile: string,
): void {
  state.active = true;
  state.label = label;
  state.startedAt = new Date();
  state.phase = "draining";
  state.error = null;
  state.dumpFile = dumpFile;
  state.pgBackupStarted = false;
  state.autoStopTimer = autoStopTimer;
}

export function setPhase(phase: BackupPhase): void {
  state.phase = phase;
}

export function markPgBackupStarted(): void {
  state.pgBackupStarted = true;
}

export function hasPgBackupStarted(): boolean {
  return state.pgBackupStarted;
}

/**
 * Transition to `failed`. Clears the maintenance flag and the auto-stop
 * timer so the app becomes responsive again, but preserves `label` and
 * sets `error` so the host-side poller can see why the run aborted. The
 * next /start (or /stop) resets to idle.
 */
export function markFailed(error: string): void {
  if (state.autoStopTimer) {
    clearTimeout(state.autoStopTimer);
  }
  state.active = false;
  state.phase = "failed";
  state.error = error;
  state.pgBackupStarted = false;
  state.autoStopTimer = null;
}

/** Normal cleanup after a successful (or acknowledged-failed) flow. */
export function clearBackupActive(): void {
  if (state.autoStopTimer) {
    clearTimeout(state.autoStopTimer);
  }
  state.active = false;
  state.label = null;
  state.startedAt = null;
  state.phase = "idle";
  state.error = null;
  state.dumpFile = null;
  state.pgBackupStarted = false;
  state.autoStopTimer = null;
}
