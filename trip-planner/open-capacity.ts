/**
 * Does it fit? The capacity line of a stay (stage 8 of
 * `reise-planen-und-unterwegs.md`): how long the open spots take, by
 * priority, against the free time of the days still to come.
 *
 * Computed on read, never stored: the open spots, their dwell and the
 * free minutes of each day (`day-times.ts`) are all there, and a stored
 * sum could only fall behind them.
 *
 * Free is what each day has left after everything already on it: its
 * fixed and firm stops, the soft ones "Tag füllen" put there, and its
 * breaks. The ways between open spots are not known before they are
 * ordered, so a share of the free time goes to them
 * (`OPEN_TRAVEL_SHARE`). It is a number for planning, and the app says
 * "ca.".
 */

import { addDays } from "./leg-dates";
import { MEAL_CATEGORIES } from "./move";
import type { IdeaPriority } from "./priority";

/** Of the free time, what the ways between open spots are taken to need. */
export const OPEN_TRAVEL_SHARE = 0.2;

export interface StayCapacity {
  /** Dwell of the open Muss spots, in minutes. */
  mustMinutes: number;
  wantMinutes: number;
  /** "Wenn Zeit". */
  maybeMinutes: number;
  /** Free minutes of the days still to come, less the travel share. */
  freeMinutes: number;
  /** How many days that is. */
  days: number;
  /** The Muss spots fit in the free time. */
  fits: boolean;
  /** How far the Muss spots run past it; 0 when they fit. */
  overMinutes: number;
}

export interface CapacityInput {
  days: ReadonlyArray<{ dayIndex: number; freeMinutes?: number }>;
  /** The open spots of the stay: its ideas without a day. */
  open: ReadonlyArray<{ priority?: IdeaPriority; dwellMinutes: number; category: string }>;
  /** The stay's first day, or null for a trip without dates. */
  startDate: string | null;
  /** Today where the stay is, "YYYY-MM-DD". */
  today: string;
}

export function capacityOf(input: CapacityInput): StayCapacity {
  // Without dates every day is still to come; with them, a day that is
  // over has nothing left to give. The running day counts whole: what
  // it has left by now is the device's to know, not the server's.
  const coming = input.days.filter((day) =>
    input.startDate === null || addDays(input.startDate, day.dayIndex) >= input.today);
  const free = coming.reduce((sum, day) => sum + Math.max(0, day.freeMinutes ?? 0), 0);
  const freeMinutes = Math.round(free * (1 - OPEN_TRAVEL_SHARE));

  const minutes: Record<IdeaPriority, number> = { must: 0, want: 0, maybe: 0 };
  for (const spot of input.open) {
    // Food is a break on the day, not a spot that needs room of its own.
    if (MEAL_CATEGORIES.has(spot.category)) continue;
    minutes[spot.priority ?? "want"] += Math.max(0, spot.dwellMinutes);
  }

  return {
    mustMinutes: minutes.must,
    wantMinutes: minutes.want,
    maybeMinutes: minutes.maybe,
    freeMinutes,
    days: coming.length,
    fits: minutes.must <= freeMinutes,
    overMinutes: Math.max(0, minutes.must - freeMinutes),
  };
}
