/**
 * When a scheduled export runs, and which period it covers (#1548, stage 9).
 *
 * Runs happen at 04:00 UTC on the due day — early enough that the night's
 * bank sync and imports are in, late enough not to collide with backups.
 * Days of month stop at 28, so "monthly on the 31st" never silently skips
 * February.
 */

export type Cadence = "weekly" | "monthly" | "yearly";

export interface ScheduleSpec {
  cadence: Cadence;
  /** 1 = Monday … 7 = Sunday (weekly). */
  weekday?: number | null;
  /** 1 … 28 (monthly, yearly). */
  day?: number | null;
  /** 1 … 12 (yearly). */
  month?: number | null;
}

export const RUN_HOUR_UTC = 4;

export class ScheduleSpecError extends Error {}

function between(value: number | null | undefined, lo: number, hi: number, field: string): number {
  if (value === null || value === undefined || !Number.isInteger(value) || value < lo || value > hi) {
    throw new ScheduleSpecError(`${field} must be a whole number from ${lo} to ${hi}`);
  }
  return value;
}

/** The spec with only the fields its cadence uses, checked. */
export function normalizeSpec(raw: ScheduleSpec): Required<ScheduleSpec> {
  switch (raw.cadence) {
    case "weekly":
      return { cadence: "weekly", weekday: between(raw.weekday, 1, 7, "weekday"), day: null, month: null };
    case "monthly":
      return { cadence: "monthly", weekday: null, day: between(raw.day, 1, 28, "day"), month: null };
    case "yearly":
      return {
        cadence: "yearly",
        weekday: null,
        day: between(raw.day, 1, 28, "day"),
        month: between(raw.month, 1, 12, "month"),
      };
    default:
      throw new ScheduleSpecError("cadence must be weekly, monthly or yearly");
  }
}

function at(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d, RUN_HOUR_UTC, 0, 0));
}

/** The first run strictly after `after`. */
export function nextRunAt(spec: ScheduleSpec, after: Date): Date {
  const s = normalizeSpec(spec);
  const y = after.getUTCFullYear();
  const m = after.getUTCMonth();
  if (s.cadence === "weekly") {
    // JS: 0 = Sunday; ours: 7 = Sunday.
    const today = at(y, m, after.getUTCDate());
    const current = today.getUTCDay() === 0 ? 7 : today.getUTCDay();
    let ahead = (s.weekday! - current + 7) % 7;
    let candidate = new Date(today.getTime() + ahead * 86_400_000);
    if (candidate <= after) {
      ahead += 7;
      candidate = new Date(today.getTime() + ahead * 86_400_000);
    }
    return candidate;
  }
  if (s.cadence === "monthly") {
    const candidate = at(y, m, s.day!);
    return candidate > after ? candidate : at(y, m + 1, s.day!);
  }
  const candidate = at(y, s.month! - 1, s.day!);
  return candidate > after ? candidate : at(y + 1, s.month! - 1, s.day!);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The period a run at `runAt` reports on, as days [from, to) — `to` is the
 * first day not included. Weekly: the seven days before the run day.
 * Monthly: the previous calendar month. Yearly: the previous calendar year.
 */
export function elapsedPeriod(cadence: Cadence, runAt: Date): { from: string; to: string } {
  const y = runAt.getUTCFullYear();
  const m = runAt.getUTCMonth();
  const d = runAt.getUTCDate();
  if (cadence === "weekly") {
    const to = new Date(Date.UTC(y, m, d));
    return { from: iso(new Date(to.getTime() - 7 * 86_400_000)), to: iso(to) };
  }
  if (cadence === "monthly") {
    return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 1))) };
  }
  return { from: iso(new Date(Date.UTC(y - 1, 0, 1))), to: iso(new Date(Date.UTC(y, 0, 1))) };
}

/** True when an ISO date or timestamp falls on a day in [from, to). */
export function inPeriod(value: string | null, period: { from: string; to: string }): boolean {
  if (!value) return false;
  const day = value.slice(0, 10);
  return day >= period.from && day < period.to;
}

/** The last day of a period, for "to" fields that include their day. */
export function lastDay(period: { to: string }): string {
  const [y, m, d] = period.to.split("-").map(Number);
  return iso(new Date(Date.UTC(y!, m! - 1, d! - 1)));
}
