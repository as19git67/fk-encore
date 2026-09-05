/**
 * Putting dates on a trip, and moving them (§4.2, §6.2).
 *
 * A trip may be planned without dates at all — "drei Tage Lissabon,
 * irgendwann" is a perfectly good plan — and it gets them later, when
 * the flight is booked. Both cases are this module's, and they are not
 * the same operation:
 *
 *   - **A trip that already has dates is shifted.** Every leg moves by
 *     the same number of days, so the gap the travellers left between
 *     two cities survives the change. Recomputing each leg from its
 *     length would quietly close a spare day between them.
 *   - **A trip with no dates gets them in sequence**, each leg starting
 *     where the previous one ends. There is nothing else it could mean,
 *     and the alternative — dating only the first leg — leaves a trip
 *     half in the calendar.
 *
 * Everything here is pure and works on `YYYY-MM-DD` strings, never on
 * `Date` in a timezone: a leg starts on a day, and a day east of UTC is
 * not the day `toISOString()` says it is.
 */

/** One leg, as far as dating it is concerned. */
export interface DatableLeg {
  legId: number;
  /** What it says today, or null for a trip without dates. */
  startDate: string | null;
  /** How long it lasts. Used only when a trip is dated for the first time. */
  days: number;
}

export interface LegDate {
  legId: number;
  startDate: string;
}

const DAY_MS = 86_400_000;

/** Is this a `YYYY-MM-DD` that names a real day? */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Round-tripping catches "2026-02-30", which the regex is happy with
  // and which `Date` silently turns into the 2nd of March.
  return toIsoDate(parseIsoDate(value)) === value;
}

/** Days between two dates, positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseIsoDate(to).getTime() - parseIsoDate(from).getTime()) / DAY_MS);
}

/** The date `days` days after `date`. */
export function addDays(date: string, days: number): string {
  const shifted = parseIsoDate(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return toIsoDate(shifted);
}

/**
 * Where every leg starts once the trip begins on `startDate`.
 *
 * The first leg is the one that gets the date asked for; what happens
 * to the rest depends on whether the trip was dated before, as
 * described at the top of this file.
 */
export function redateLegs(legs: readonly DatableLeg[], startDate: string): LegDate[] {
  if (legs.length === 0) return [];
  const first = legs[0];

  if (first.startDate) {
    const shift = daysBetween(first.startDate, startDate);
    return legs.map((leg) => ({
      legId: leg.legId,
      // A leg that somehow has no date of its own still gets one, or a
      // half-dated trip would stay half-dated for ever.
      startDate: leg.startDate ? addDays(leg.startDate, shift) : startDate,
    }));
  }

  let cursor = startDate;
  return legs.map((leg) => {
    const dated = { legId: leg.legId, startDate: cursor };
    cursor = addDays(cursor, Math.max(1, leg.days));
    return dated;
  });
}

function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
