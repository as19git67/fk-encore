/**
 * Which day of which leg is being lived right now (§22.7).
 *
 * A date used to be enough: legs followed each other day by day, and a
 * date named one day of one leg. With a journey that has a time as well
 * as a date, one calendar day can hold three legs — the morning of the
 * one being left, the journey, the evening of the one arrived at. The
 * answer now needs the clock too.
 *
 * Each leg's day on that date has a window: it opens at the start of
 * the day, or later on the first day of a leg (the arrival, or the
 * departure of a journey), and closes at midnight, or earlier on a day
 * with a departure. The day whose window holds the minute is the one
 * being lived. Between two windows — the minutes between leaving and a
 * journey the plan does not know about — the one that opened last is
 * still the truth.
 *
 * Pure: legs, a date and a minute in, a day out. The app asks the same
 * question with the same rule (`TripPlan.position(on:)`).
 */

import { addDays } from "./leg-dates";

export interface RunningLeg {
  position: number;
  kind?: "stay" | "transit";
  startDate: string | null;
  /** When the group reaches this leg — the start of its first day. */
  arriveMinutes: number | null;
  /** For a journey, when it sets off on its first day. */
  departMinutes?: number | null;
  days: readonly RunningDay[];
}

export interface RunningDay {
  dayIndex: number;
  fixpoints: readonly { kind?: string; startMinutes: number }[];
}

export interface RunningDayAt<L extends RunningLeg> {
  leg: L;
  day: L["days"][number];
}

/** The window of one leg's day, in minutes past midnight. */
export function windowOf(leg: RunningLeg, day: RunningDay): { from: number; to: number } {
  const first = day.dayIndex === Math.min(...leg.days.map((d) => d.dayIndex));
  const opens = !first
    ? 0
    : leg.kind === "transit"
      ? leg.departMinutes ?? 0
      : leg.arriveMinutes ?? 0;
  const departures = day.fixpoints
    .filter((f) => f.kind === "departure")
    .map((f) => f.startMinutes);
  const closes = departures.length > 0 ? Math.min(...departures) : 24 * 60;
  return { from: opens, to: Math.max(opens, closes) };
}

export function runningDayAt<L extends RunningLeg>(
  legs: readonly L[],
  date: string,
  minutes: number,
): RunningDayAt<L> | null {
  const candidates: RunningDayAt<L>[] = [];
  for (const leg of [...legs].sort((a, b) => a.position - b.position)) {
    if (!leg.startDate) continue;
    const day = leg.days.find((d) => addDays(leg.startDate as string, d.dayIndex) === date);
    if (day) candidates.push({ leg, day });
  }
  if (candidates.length <= 1) return candidates[0] ?? null;

  const inside = candidates.find(({ leg, day }) => {
    const w = windowOf(leg, day);
    return minutes >= w.from && minutes < w.to;
  });
  if (inside) return inside;
  // Between windows: the latest one that has opened. Before any has
  // opened: the first of the day.
  const opened = candidates.filter(({ leg, day }) => windowOf(leg, day).from <= minutes);
  return opened[opened.length - 1] ?? candidates[0];
}
