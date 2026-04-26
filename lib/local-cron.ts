/**
 * Tiny in-process scheduler.
 *
 * Encore.ts CronJobs are scheduled by the Encore Cloud control plane;
 * in our self-hosted `encore build docker` deployment they register
 * but never fire. This module is the replacement: callers register
 * jobs at boot via `schedule()` and call `startLocalCron()` once from
 * the service file. Each job advances its own next-fire time after
 * every run, and the scheduler arms exactly one timer per job — no
 * 5-min polling, the timer wakes the moment the next job is due.
 *
 * Catch-up on missed runs (e.g. container was down across the daily
 * 03:00 UTC export) is intentionally NOT done — same semantics as
 * Encore's CronJob, which also just resumes from the next future
 * tick. If you want a startup catch-up, do an explicit one-shot call
 * at boot before `startLocalCron()`.
 *
 * Usage:
 *   schedule({
 *     name: "finance-tan-cleanup",
 *     nextFire: everyMs(60 * 60_000),
 *     run: () => cleanupExpiredTanSessions(),
 *   });
 *   schedule({
 *     name: "finance-export-snapshot",
 *     nextFire: dailyAtUtc(3, 0),
 *     run: () => runFinanceExport(),
 *   });
 *   startLocalCron();
 */

import log from "encore.dev/log";

export interface ScheduledJob {
  name: string;
  /**
   * Returns the absolute Date at which the job should fire next,
   * given that the previous fire (or boot) was at `after`. Return
   * `null` to deactivate the job permanently.
   */
  nextFire: (after: Date) => Date | null;
  /** The work to do. Errors are logged and swallowed. */
  run: () => Promise<unknown>;
}

interface Entry {
  job: ScheduledJob;
  timer: NodeJS.Timeout | null;
}

const entries: Entry[] = [];
let started = false;

export function schedule(job: ScheduledJob): void {
  if (started) {
    throw new Error(
      `localCron: cannot schedule '${job.name}' after startLocalCron()`,
    );
  }
  entries.push({ job, timer: null });
}

export function startLocalCron(): void {
  if (started) return;
  started = true;
  const now = new Date();
  for (const entry of entries) {
    armNext(entry, now);
  }
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
    return;
  }

  if (!next) {
    log.info("localCron: job deactivated", { name: entry.job.name });
    return;
  }

  // setTimeout's max delay is ~24.8 days (2^31-1 ms). Schedules longer
  // than that re-arm in chunks; for our cron uses (≤24h) this never
  // triggers, but it's cheap to guard against.
  const MAX_DELAY = 2_147_483_647;
  const delayMs = Math.max(0, next.getTime() - Date.now());
  if (delayMs > MAX_DELAY) {
    entry.timer = setTimeout(() => armNext(entry, new Date()), MAX_DELAY);
    return;
  }

  log.info("localCron: scheduled", {
    name: entry.job.name,
    next_fire: next.toISOString(),
    delay_ms: delayMs,
  });

  entry.timer = setTimeout(async () => {
    log.info("localCron: firing", { name: entry.job.name });
    const startedAt = Date.now();
    try {
      await entry.job.run();
      log.info("localCron: job ok", {
        name: entry.job.name,
        duration_ms: Date.now() - startedAt,
      });
    } catch (err) {
      log.error("localCron: job threw", {
        name: entry.job.name,
        duration_ms: Date.now() - startedAt,
        err: (err as Error).message,
      });
    }
    armNext(entry, new Date());
  }, delayMs);
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
