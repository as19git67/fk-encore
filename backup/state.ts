/**
 * Shared in-memory state for the backup/maintenance flow.
 *
 * All Encore services run in the same Node process, so a simple module-level
 * variable is sufficient for coordinating maintenance mode across services.
 *
 * State transitions:
 *   idle  -> backup-active   (via /internal/backup/start)
 *   backup-active -> idle    (via /internal/backup/stop, auto-stop timer, or process restart)
 */

export interface BackupState {
  active: boolean;
  label: string | null;
  startedAt: Date | null;
  /** Timer that force-stops a stuck backup if /internal/backup/stop never arrives. */
  autoStopTimer: ReturnType<typeof setTimeout> | null;
}

const state: BackupState = {
  active: false,
  label: null,
  startedAt: null,
  autoStopTimer: null,
};

export function isInBackupMode(): boolean {
  return state.active;
}

export function getBackupState(): Readonly<BackupState> {
  return state;
}

export function setBackupActive(label: string, autoStopTimer: ReturnType<typeof setTimeout>): void {
  state.active = true;
  state.label = label;
  state.startedAt = new Date();
  state.autoStopTimer = autoStopTimer;
}

export function clearBackupActive(): void {
  if (state.autoStopTimer) {
    clearTimeout(state.autoStopTimer);
  }
  state.active = false;
  state.label = null;
  state.startedAt = null;
  state.autoStopTimer = null;
}
