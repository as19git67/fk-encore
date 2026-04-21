/**
 * Event-loop pressure monitor.
 *
 * Periodically measures how far behind the event loop is falling (lag)
 * by scheduling a timer and comparing the actual elapsed time to the
 * expected interval.
 *
 * Two thresholds are reported:
 *   - soft: UI/request work is starting to queue. Scan workers should
 *           add a small delay between jobs.
 *   - hard: health checks are at risk of missing their deadline. Scan
 *           workers should stop dequeuing entirely until pressure drops.
 *
 * Configuration (environment variables):
 *   EVENT_LOOP_CHECK_INTERVAL_MS      – measurement interval (default: 1000)
 *   EVENT_LOOP_SOFT_THRESHOLD_MS      – lag that triggers soft pressure (default: 200)
 *   EVENT_LOOP_LAG_THRESHOLD_MS       – lag that triggers hard pressure (default: 500)
 *   WORKER_PRESSURE_DELAY_MS          – worker delay under soft pressure (default: 250)
 *   WORKER_HARD_PRESSURE_DELAY_MS     – worker delay under hard pressure (default: 1000)
 */

// ─── configuration ───────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = parseInt(
  process.env.EVENT_LOOP_CHECK_INTERVAL_MS ?? "1000",
  10,
);

const SOFT_THRESHOLD_MS = parseInt(
  process.env.EVENT_LOOP_SOFT_THRESHOLD_MS ?? "200",
  10,
);

const HARD_THRESHOLD_MS = parseInt(
  process.env.EVENT_LOOP_LAG_THRESHOLD_MS ?? "500",
  10,
);

/** Delay (ms) workers should wait between jobs under soft pressure. */
export const WORKER_PRESSURE_DELAY_MS = parseInt(
  process.env.WORKER_PRESSURE_DELAY_MS ?? "250",
  10,
);

/** Delay (ms) workers should wait between jobs under hard pressure. */
export const WORKER_HARD_PRESSURE_DELAY_MS = parseInt(
  process.env.WORKER_HARD_PRESSURE_DELAY_MS ?? "1000",
  10,
);

// ─── state ───────────────────────────────────────────────────────────────────

let currentLagMs = 0;
let pressureLevel: "none" | "soft" | "hard" = "none";
let timer: ReturnType<typeof setTimeout> | null = null;

// ─── measurement loop ────────────────────────────────────────────────────────

function measure(): void {
  const start = Date.now();
  timer = setTimeout(() => {
    const elapsed = Date.now() - start;
    currentLagMs = Math.max(0, elapsed - CHECK_INTERVAL_MS);
    const prev = pressureLevel;
    if (currentLagMs > HARD_THRESHOLD_MS) pressureLevel = "hard";
    else if (currentLagMs > SOFT_THRESHOLD_MS) pressureLevel = "soft";
    else pressureLevel = "none";

    if (pressureLevel !== prev) {
      if (pressureLevel === "hard") {
        console.warn(
          `[event-loop-pressure] HARD pressure – lag=${currentLagMs}ms (threshold=${HARD_THRESHOLD_MS}ms) — workers pausing`,
        );
      } else if (pressureLevel === "soft") {
        console.warn(
          `[event-loop-pressure] soft pressure – lag=${currentLagMs}ms (threshold=${SOFT_THRESHOLD_MS}ms) — workers throttling`,
        );
      } else {
        console.log(
          `[event-loop-pressure] pressure relieved – lag=${currentLagMs}ms`,
        );
      }
    }

    measure(); // schedule next measurement
  }, CHECK_INTERVAL_MS);
}

// ─── public API ──────────────────────────────────────────────────────────────

/** Start the pressure monitor.  Idempotent. */
export function startPressureMonitor(): void {
  if (timer) return;
  console.log(
    `[event-loop-pressure] monitor started (interval=${CHECK_INTERVAL_MS}ms, soft=${SOFT_THRESHOLD_MS}ms, hard=${HARD_THRESHOLD_MS}ms)`,
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

/**
 * True when the event loop is lagging beyond the HARD threshold.
 * Scan workers should not dequeue new work in this state.
 */
export function isUnderPressure(): boolean {
  return pressureLevel === "hard";
}

/**
 * True when the event loop is at least in soft pressure. Workers may still
 * dequeue but should throttle between jobs.
 */
export function isUnderSoftPressure(): boolean {
  return pressureLevel !== "none";
}

/** Current pressure level for dispatcher decisions. */
export function getPressureLevel(): "none" | "soft" | "hard" {
  return pressureLevel;
}

/** Current event-loop lag in milliseconds. */
export function getEventLoopLagMs(): number {
  return currentLagMs;
}
