/**
 * What an idea row says beside its name (ideas plan, stage 3): closed
 * on a day of the stay, and the ticket somebody booked for it.
 *
 * Computed on the way out of the store, never stored: the opening
 * hours and the fixpoints are stored, and a second copy of what follows
 * from them could only disagree.
 */

import { addDays } from "./leg-dates";
import { closedDates, openingOn } from "./opening-hours";
import type { StoredCandidate, StoredDay } from "./plan-store";

/** "Mo 7.9." for a date. */
export function shortDate(date: string): string {
  const at = new Date(`${date}T12:00:00Z`);
  const day = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][at.getUTCDay()];
  return `${day} ${at.getUTCDate()}.${at.getUTCMonth() + 1}.`;
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function withIdeaHints(
  days: StoredDay[],
  pool: StoredCandidate[],
  startDate: string | null,
): { days: StoredDay[]; pool: StoredCandidate[] } {
  const dateOf = (dayIndex: number) => (startDate ? addDays(startDate, dayIndex) : null);
  const dates = startDate ? days.map((d) => dateOf(d.dayIndex)!).filter(Boolean) : [];

  // A booked visit for a spot (§4.4): its day and hour, whichever day it is on.
  const tickets = new Map<string, string>();
  for (const day of days) {
    for (const fix of day.fixpoints) {
      if (!fix.spotRef || fix.startMinutes === null) continue;
      const date = dateOf(day.dayIndex);
      tickets.set(fix.spotRef, `${date ? shortDate(date) : `Tag ${day.dayIndex + 1}`} ${clock(fix.startMinutes)}`);
    }
  }

  return {
    // Only where there is something to say, so a pool without hours
    // reads exactly as before.
    pool: pool.map((c) => {
      const closedOn = c.openingHours ? closedDates(c.openingHours, dates) : [];
      const ticket = tickets.get(c.osmRef);
      if (closedOn.length === 0 && !ticket) return c;
      return { ...c, ...(closedOn.length > 0 ? { closedOn } : {}), ...(ticket ? { ticket } : {}) };
    }),
    days: days.map((day) => {
      const date = dateOf(day.dayIndex);
      if (!date) return day;
      return {
        ...day,
        blocks: day.blocks.map((block) => ({
          ...block,
          stops: block.stops.map((stop) => (stop.openingHours
            ? { ...stop, closedThatDay: openingOn(stop.openingHours, date).state === "closed" }
            : stop)),
        })),
      };
    }),
  };
}
