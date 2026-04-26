/**
 * Tiny in-process scheduler.
 *
 * Encore.ts CronJobs are scheduled by the Encore Cloud control plane;
 * in our self-hosted `encore build docker` deployment they register
 * but never fire. This module is the replacement: callers register
 * jobs at boot via `schedule()` and call `startLocalCron()` once from
 * a service file. Each job advances its own next-fire time after every
 * run, and the scheduler arms exactly one timer per job — no polling,
 * the timer wakes the moment the next job is due.
 *
 * Multiple services can each call `schedule()` and `startLocalCron()`
 * independently — the calls are idempotent and ordering-safe. A
 * `schedule()` after `startLocalCron()` arms its timer immediately, so
 * a service whose boot file runs late in the import graph still gets
 * its jobs registered.
 *
 * Catch-up on missed runs (e.g. container was down across the daily
 * 03:00 UTC export) is intentionally NOT done — same semantics as
 * Encore's CronJob, which also just resumes from the next future
 * tick. If you want a startup catch-up, do an explicit one-shot call
 * at boot before `startLocalCron()`.
 *
 * Last-run state (status, duration, next fire) is kept per entry and
 * surfaced via `inspectJobs()` for the admin UI. State lives only in
 * memory — restarts reset it. That's fine for an at-a-glance health
 * panel; long-term audit logging would need its own table.
 *
 * Usage:
 *   schedule({
 *     name: "finance-tan-cleanup",
 *     nextFire: everyMs(60 * 60_000),
 *     run: () => cleanupExpiredTanSessions(),
 *   });
 *   startLocalCron();
 */

import log from "encore.dev/log";

export interface ScheduledJob {
  name: string;
  /** Human-readable description for the admin UI. */
  description?: string;
  /** Service the job logically belongs to (for grouping in the UI). */
  service?: string;
  /**
   * Schedule shape, free-form string for display ("every 5m", "daily 03:00 UTC", …).
   * Computed by the helpers below; pass through if you build a custom `nextFire`.
   */
  scheduleLabel?: string;
  /**
   * Returns the absolute Date at which the job should fire next,
   * given that the previous fire (or boot) was at `after`. Return
   * `null` to deactivate the job permanently.
   */
  nextFire: (after: Date) => Date | null;
  /** The work to do. Errors are logged and swallowed. */
  run: () => Promise<unknown>;
}

export type JobStatus = "scheduled" | "running" | "ok" | "error" | "deactivated";

export interface JobInspectEntry {
  name: string;
  description: string | null;
  service: string | null;
  schedule_label: string | null;
  status: JobStatus;
  next_fire_at: string | null;
  last_run_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  run_count: number;
  error_count: number;
}

interface Entry {
  job: ScheduledJob;
  timer: NodeJS.Timeout | null;
  status: JobStatus;
  next_fire_at: Date | null;
  last_run_at: Date | null;
  last_duration_ms: number | null;
  last_error: string | null;
  run_count: number;
  error_count: number;
}

const entries: Entry[] = [];
let started = false;

export function schedule(job: ScheduledJob): void {
  // Names should be unique — keeps the admin UI unambiguous and
  // prevents accidental double-registration from a re-imported module.
  if (entries.some((e) => e.job.name === job.name)) {
    log.warn("localCron: duplicate schedule() call ignored", { name: job.name });
    return;
  }
  const entry: Entry = {
    job,
    timer: null,
    status: "scheduled",
    next_fire_at: null,
    last_run_at: null,
    last_duration_ms: null,
    last_error: null,
    run_count: 0,
    error_count: 0,
  };
  entries.push(entry);
  if (started) {
    // Late registration (some other service already started the
    // scheduler): arm immediately so we don't wait for an explicit
    // re-start.
    armNext(entry, new Date());
  }
}

export function startLocalCron(): void {
  if (started) return;
  started = true;
  const now = new Date();
  for (const entry of entries) {
    if (!entry.timer) armNext(entry, now);
  }
}

export function inspectJobs(): JobInspectEntry[] {
  return entries.map((e) => ({
    name: e.job.name,
    description: e.job.description ?? null,
    service: e.job.service ?? null,
    schedule_label: e.job.scheduleLabel ?? null,
    status: e.status,
    next_fire_at: e.next_fire_at?.toISOString() ?? null,
    last_run_at: e.last_run_at?.toISOString() ?? null,
    last_duration_ms: e.last_duration_ms,
    last_error: e.last_error,
    run_count: e.run_count,
    error_count: e.error_count,
  }));
}

/** Trigger a job by name immediately (off the regular schedule). */
export async function runJobNow(name: string): Promise<JobInspectEntry | null> {
  const entry = entries.find((e) => e.job.name === name);
  if (!entry) return null;
  await runEntry(entry);
  return inspectJobs().find((j) => j.name === name) ?? null;
}

/** For tests: stop all timers and reset registry. */
export function _resetLocalCron(): void {
  for (const entry of entries) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  entries.length = 0;
  started = false;
}

function armNext(entry: Entry, after: Date): void {
  let next: Date | null;
  try {
    next = entry.job.nextFire(after);
  } catch (err) {
    log.error("localCron: nextFire threw, deactivating job", {
      name: entry.job.name,
      err: (err as Error).message,
    });
    entry.status = "deactivated";
    entry.next_fire_at = null;
    return;
  }

  if (!next) {
    log.info("localCron: job deactivated", { name: entry.job.name });
    entry.status = "deactivated";
    entry.next_fire_at = null;
    return;
  }

  // setTimeout's max delay is ~24.8 days (2^31-1 ms). Schedules longer
  // than that re-arm in chunks; for our cron uses (≤24h) this never
  // triggers, but it's cheap to guard against.
  const MAX_DELAY = 2_147_483_647;
  const delayMs = Math.max(0, next.getTime() - Date.now());
  entry.next_fire_at = next;
  if (entry.status !== "error" && entry.status !== "ok") {
    entry.status = "scheduled";
  }

  if (delayMs > MAX_DELAY) {
    entry.timer = setTimeout(() => armNext(entry, new Date()), MAX_DELAY);
    return;
  }

  log.info("localCron: scheduled", {
    name: entry.job.name,
    next_fire: next.toISOString(),
    delay_ms: delayMs,
  });

  entry.timer = setTimeout(() => {
    runEntry(entry).finally(() => armNext(entry, new Date()));
  }, delayMs);
}

async function runEntry(entry: Entry): Promise<void> {
  log.info("localCron: firing", { name: entry.job.name });
  entry.status = "running";
  const startedAt = Date.now();
  entry.last_run_at = new Date(startedAt);
  try {
    await entry.job.run();
    entry.last_duration_ms = Date.now() - startedAt;
    entry.last_error = null;
    entry.run_count++;
    entry.status = "ok";
    log.info("localCron: job ok", {
      name: entry.job.name,
      duration_ms: entry.last_duration_ms,
    });
  } catch (err) {
    entry.last_duration_ms = Date.now() - startedAt;
    entry.last_error = (err as Error).message ?? String(err);
    entry.error_count++;
    entry.status = "error";
    log.error("localCron: job threw", {
      name: entry.job.name,
      duration_ms: entry.last_duration_ms,
      err: entry.last_error,
    });
  }
}

// -----------------------------------------------------------------------
// Helpers for common schedule shapes
// -----------------------------------------------------------------------

/** Fire every `intervalMs` after the previous fire (or boot). */
export function everyMs(intervalMs: number): ScheduledJob["nextFire"] {
  return (after) => new Date(after.getTime() + intervalMs);
}

/**
 * Fire daily at the given UTC time. If the time today has already
 * passed (relative to `after`), the next fire is tomorrow.
 */
export function dailyAtUtc(
  hour: number,
  minute: number = 0,
): ScheduledJob["nextFire"] {
  return (after) => {
    const candidate = new Date(
      Date.UTC(
        after.getUTCFullYear(),
        after.getUTCMonth(),
        after.getUTCDate(),
        hour,
        minute,
        0,
        0,
      ),
    );
    if (candidate.getTime() <= after.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate;
  };
}
