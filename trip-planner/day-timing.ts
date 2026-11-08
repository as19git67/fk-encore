/**
 * The clock of a day of ideas (ideas plan, stage 4).
 *
 * A day keeps no fixed drawers; its spots block is one window, and the
 * order of the stops in it gives estimated times: the way to a stop,
 * then the wait at its door when it opens later or a ticket is for
 * later, then the visit. This module is that arithmetic and nothing
 * else — the same one the ordering searches with (`day-order.ts`) and
 * the plan read shows ("ca. 10:40"), so the two can never disagree.
 *
 * Pure: no clock, no database, no map.
 */

import { openingOn, type OpenWindow } from "./opening-hours";

/** One thing on the day's line, in the order it is done. */
export interface TimedItem {
  ref: string;
  /** The way to it from the item before; zero for a break. */
  travelMinutes: number;
  dwellMinutes: number;
  /** OpenStreetMap's opening hours, when the map has them. */
  openingHours?: string | null;
  /** A booked visit: the visit begins at this hour, not before. */
  ticketMinutes?: number | null;
}

/** A stretch of the day nothing else can happen in: an appointment. */
export interface BlockedSpan {
  from: number;
  to: number;
}

export interface TimedEntry {
  ref: string;
  /** When the group gets there. */
  arriveMinutes: number;
  /** When the visit begins — later than the arrival by the wait. */
  startMinutes: number;
  endMinutes: number;
  waitMinutes: number;
  /** Its opening hours say closed all day on this date. */
  closed: boolean;
  /** Open that day, but not for the whole visit at this hour. */
  outsideHours: boolean;
  /** Minutes the visit misses its ticket or its opening by. */
  lateMinutes: number;
}

export interface TimedLine {
  entries: TimedEntry[];
  /** When the last item ends; the start when there is none. */
  endMinutes: number;
  /** Ways, visits and breaks — what the day spends on purpose. */
  plannedMinutes: number;
  /** Standing at doors and waiting for tickets. */
  waitMinutes: number;
}

export interface TimeLineInput {
  startMinutes: number;
  items: readonly TimedItem[];
  /** The date of the day, YYYY-MM-DD; without it opening hours are not read. */
  date?: string | null;
  blocked?: readonly BlockedSpan[];
}

/** The day's line on the clock, item by item. */
export function timeLine(input: TimeLineInput): TimedLine {
  const blocked = [...(input.blocked ?? [])].sort((a, b) => a.from - b.from);
  const entries: TimedEntry[] = [];
  let clock = input.startMinutes;
  let planned = 0;
  let waited = 0;
  for (const item of input.items) {
    const timed = timeItem(item, clock, input.date ?? null, blocked);
    entries.push(timed);
    planned += item.travelMinutes + item.dwellMinutes;
    waited += timed.waitMinutes;
    clock = timed.endMinutes;
  }
  return { entries, endMinutes: clock, plannedMinutes: planned, waitMinutes: waited };
}

/** One item, starting from `clock`. Exported for the ordering's search. */
export function timeItem(
  item: TimedItem,
  clock: number,
  date: string | null,
  blocked: readonly BlockedSpan[] = [],
): TimedEntry {
  const arrive = clock + Math.max(0, item.travelMinutes);
  const dwell = Math.max(0, item.dwellMinutes);
  let start = arrive;
  let closed = false;
  let outsideHours = false;
  let late = 0;

  if (typeof item.ticketMinutes === "number") {
    start = Math.max(arrive, item.ticketMinutes);
    late = Math.max(0, arrive - item.ticketMinutes);
  } else if (date && item.openingHours) {
    const opening = openingCached(item.openingHours, date);
    if (opening.state === "closed") {
      closed = true;
    } else if (opening.state === "open") {
      const fit = fitIn(opening.windows, arrive, dwell);
      if (fit === null) {
        outsideHours = true;
        late = lateBy(opening.windows, arrive, dwell);
      } else {
        start = fit;
      }
    }
  }

  // An appointment in the way: the visit waits until it is over.
  for (const span of blocked) {
    if (start < span.to && start + dwell > span.from) start = Math.max(start, span.to);
  }

  return {
    ref: item.ref,
    arriveMinutes: arrive,
    startMinutes: start,
    endMinutes: start + dwell,
    waitMinutes: start - arrive,
    closed,
    outsideHours,
    lateMinutes: late,
  };
}

const openings = new Map<string, ReturnType<typeof openingOn>>();

/** The ordering asks the same place about the same date thousands of times. */
function openingCached(spec: string, date: string): ReturnType<typeof openingOn> {
  const key = `${date}\u0000${spec}`;
  let found = openings.get(key);
  if (!found) {
    if (openings.size > 2000) openings.clear();
    found = openingOn(spec, date);
    openings.set(key, found);
  }
  return found;
}

/** The earliest start at or after `arrive` at which the whole visit fits a window. */
function fitIn(windows: readonly OpenWindow[], arrive: number, dwell: number): number | null {
  for (const window of windows) {
    const start = Math.max(arrive, window.from);
    if (start + dwell <= window.to) return start;
  }
  return null;
}

/** How far the visit at its arrival misses the window it comes closest to. */
function lateBy(windows: readonly OpenWindow[], arrive: number, dwell: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const window of windows) {
    const start = Math.max(arrive, window.from);
    const over = Math.max(0, start + dwell - window.to);
    best = Math.min(best, over);
  }
  return Number.isFinite(best) ? Math.max(1, Math.round(best)) : 0;
}
