/**
 * Event-loop pressure monitor.
 *
 * Periodically measures how far behind the event loop is falling (lag)
 * by scheduling a timer and comparing the actual elapsed time to the
 * expected interval.  When lag exceeds a configurable threshold the
 * system is considered "under pressure" and background workers should
 * back off so that latency-sensitive requests (health checks, UI
 * queries) can be served in time.
 *
 * Configuration (environment variables):
 *   EVENT_LOOP_CHECK_INTERVAL_MS  – measurement interval   (default: 2000)
 *   EVENT_LOOP_LAG_THRESHOLD_MS   – lag that triggers back-pressure (default: 500)
 *   WORKER_PRESSURE_DELAY_MS      – worker delay under pressure     (default: 1000)
 */

// ─── configuration ───────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = parseInt(
  process.env.EVENT_LOOP_CHECK_INTERVAL_MS ?? "2000",
  10,
);

const LAG_THRESHOLD_MS = parseInt(
  process.env.EVENT_LOOP_LAG_THRESHOLD_MS ?? "500",
  10,
);

/** Delay (ms) workers should wait between jobs when under pressure. */
export const WORKER_PRESSURE_DELAY_MS = parseInt(
  process.env.WORKER_PRESSURE_DELAY_MS ?? "1000",
  10,
);

// ─── state ───────────────────────────────────────────────────────────────────

let currentLagMs = 0;
let underPressure = false;
let timer: ReturnType<typeof setTimeout> | null = null;

// ─── measurement loop ────────────────────────────────────────────────────────

function measure(): void {
  const start = Date.now();
  timer = setTimeout(() => {
    const elapsed = Date.now() - start;
    currentLagMs = Math.max(0, elapsed - CHECK_INTERVAL_MS);
    const wasPressured = underPressure;
    underPressure = currentLagMs > LAG_THRESHOLD_MS;

    if (underPressure && !wasPressured) {
      console.warn(
        `[event-loop-pressure] server under pressure – lag=${currentLagMs}ms (threshold=${LAG_THRESHOLD_MS}ms)`,
      );
    } else if (!underPressure && wasPressured) {
      console.log(
        `[event-loop-pressure] pressure relieved – lag=${currentLagMs}ms`,
      );
    }

    measure(); // schedule next measurement
  }, CHECK_INTERVAL_MS);
}

// ─── public API ──────────────────────────────────────────────────────────────

/** Start the pressure monitor.  Idempotent. */
export function startPressureMonitor(): void {
  if (timer) return;
  console.log(
    `[event-loop-pressure] monitor started (interval=${CHECK_INTERVAL_MS}ms, threshold=${LAG_THRESHOLD_MS}ms, backoff=${WORKER_PRESSURE_DELAY_MS}ms)`,
  );
  measure();
}

/** Stop the pressure monitor. */
export function stopPressureMonitor(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** True when the event loop is lagging beyond the configured threshold. */
export function isUnderPressure(): boolean {
  return underPressure;
}

/** Current event-loop lag in milliseconds. */
export function getEventLoopLagMs(): number {
  return currentLagMs;
}
