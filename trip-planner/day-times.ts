/**
 * The day of ideas on the clock (ideas plan, stage 4): its window, the
 * estimated time of each stop, and what is planned, waited and free.
 *
 * Computed on the way out of the store, like the idea hints: the
 * order, the ways, the opening hours and the fixpoints are stored, and
 * a stored "ca. 10:40" could only fall behind them.
 *
 * The window of a spots block is where the frame put it (`scheduleDay`).
 * On a trip of ideas the block spans its appointments; a block stored
 * before that was cut at one, and the window carries on to the
 * appointment's end. Either way the appointment stands in the line as
 * time nothing else happens in.
 */

import { isVisit } from "./frame-spots";
import { blockStart, excursionPlaces } from "./excursions";
import { addDays } from "./leg-dates";
import { lineOf, type OrderBreak, type OrderInput, type OrderStop } from "./day-order";
import { resolveFixpoints, type Fixpoint } from "./fixpoints";
import type { BlockedSpan } from "./day-timing";
import type { StoredBlock, StoredDay, StoredStop } from "./plan-store";
import { leaveFrom } from "./extent";
import { travelClassFor, travelLeg, type Coordinate, type TransportMode, type TravelLeg } from "./travel";
import { DAY_START, segmentKey, type SegmentChoice } from "./segments";

/** A break on the day: a label and minutes, no venue (migration 0303). */
export interface DayBreak {
  id: string;
  label: string;
  minutes: number;
  /** The spots block it stands in. */
  blockId: string;
  /** Where in that block's line, counting stops and breaks from zero. */
  position: number;
  /** When it begins, estimated (read only). */
  etaMinutes?: number;
}

/** The part of the day a spots block holds, on the clock. */
export interface DayWindow {
  startMinutes: number;
  endMinutes: number;
}

/** What one spots block of a day needs for the ordering and the clock. */
export interface BlockFrame {
  window: DayWindow;
  blocked: BlockedSpan[];
  /** Booked visits by spot: the hour the visit begins. */
  tickets: Map<string, number>;
}

/** The window and the hard times of one spots block. */
export function frameOf(block: Pick<StoredBlock, "startMinutes" | "budgetMinutes">, fixpoints: readonly Fixpoint[]): BlockFrame | null {
  if (typeof block.startMinutes !== "number") return null;
  const start = block.startMinutes;
  let end = start + block.budgetMinutes;
  const blocked: BlockedSpan[] = [];
  const tickets = new Map<string, number>();
  for (const fix of resolveFixpoints(fixpoints)) {
    if (fix.kind !== "appointment" || fix.blockId) continue;
    if (isVisit(fix)) tickets.set(fix.spotRef!, fix.startMinutes);
    // Only what falls inside: an appointment before or after the block
    // already moved its edges. One the block was cut at (its guard is
    // the block's end) carries the window on to its own end; one the
    // block spans (`spanAppointments`) keeps it, unless it runs longer.
    if (fix.guardStartMinutes < start || fix.guardStartMinutes > end) continue;
    end = Math.max(end, fix.endMinutes);
    if (!isVisit(fix)) blocked.push({ from: fix.guardStartMinutes, to: fix.endMinutes });
  }
  return { window: { startMinutes: start, endMinutes: end }, blocked, tickets };
}

export function orderStopOf(
  stop: Pick<StoredStop, "osmRef" | "lat" | "lon" | "extent" | "dwellMinutes" | "openingHours" | "priority">,
  tickets: ReadonlyMap<string, number>): OrderStop {
  return {
    ref: stop.osmRef,
    lat: stop.lat,
    lon: stop.lon,
    extent: stop.extent,
    dwellMinutes: stop.dwellMinutes,
    openingHours: stop.openingHours ?? null,
    ticketMinutes: tickets.get(stop.osmRef) ?? null,
    priority: stop.priority,
  };
}

export function breakRef(id: string): string {
  return `break:${id}`;
}

export function orderBreaksOf(breaks: readonly DayBreak[] | undefined, blockId: string): OrderBreak[] {
  return (breaks ?? [])
    .filter((b) => b.blockId === blockId)
    .map((b) => ({ ref: breakRef(b.id), minutes: b.minutes, position: b.position }));
}

/**
 * Every day of a trip of ideas with its clock. Days of other trips, and
 * days without a frame time, come back as they went in.
 */
export function withDayTimes(
  days: StoredDay[],
  opts: {
    ideas: boolean;
    startDate: string | null;
    anchor: Coordinate;
    mode: TransportMode;
    /** Modes picked in "Weg" for single segments (stage 6), by `segmentKey`. */
    segments?: ReadonlyMap<string, SegmentChoice>;
  },
): StoredDay[] {
  if (!opts.ideas) return days;
  return days.map((day) => {
    const date = opts.startDate ? addDays(opts.startDate, day.dayIndex) : null;
    let position: Coordinate = day.anchor ? { lat: day.anchor.lat, lon: day.anchor.lon } : opts.anchor;
    const chosen = chosenSegments(day, position, opts.segments);
    let windowStart: number | null = null;
    let windowEnd: number | null = null;
    let planned = 0;
    let waited = 0;
    let overrun = 0;
    let windowMinutes = 0;
    const breakEtas = new Map<string, number>();
    const home = position;
    const places = excursionPlaces(day.excursions);
    const blocks = day.blocks.map((block, index) => {
      const frame = block.kind === "spots" ? frameOf(block, day.fixpoints) : null;
      position = blockStart(block.id, index > 0 ? day.blocks[index - 1].id : null, position, home, places);
      const start = position;
      if (block.stops.length > 0) position = leaveFrom(block.stops[block.stops.length - 1]);
      if (!frame) return block;
      const input: OrderInput = {
        start,
        startMinutes: frame.window.startMinutes,
        endMinutes: frame.window.endMinutes,
        stops: [],
        mode: opts.mode,
        date,
        blocked: frame.blocked,
        ...(chosen.size > 0 ? { travel: travelWith(chosen) } : {}),
      };
      const stops = block.stops.map((s) => orderStopOf(s, frame.tickets));
      const line = lineOf(input, stops, orderBreaksOf(day.breaks, block.id));
      windowStart = windowStart === null ? frame.window.startMinutes : Math.min(windowStart, frame.window.startMinutes);
      windowEnd = windowEnd === null ? frame.window.endMinutes : Math.max(windowEnd, frame.window.endMinutes);
      windowMinutes += frame.window.endMinutes - frame.window.startMinutes;
      planned += line.plannedMinutes;
      waited += line.waitMinutes;
      overrun += Math.max(0, line.endMinutes - frame.window.endMinutes);
      const byRef = new Map(line.entries.map((e) => [e.ref, e]));
      for (const brk of day.breaks ?? []) {
        const entry = byRef.get(breakRef(brk.id));
        if (entry) breakEtas.set(brk.id, entry.startMinutes);
      }
      return {
        ...block,
        stops: block.stops.map((stop) => {
          const entry = byRef.get(stop.osmRef);
          if (!entry) return stop;
          const choice = chosen.get(stop.osmRef)?.choice;
          return {
            ...stop,
            ...(choice
              ? {
                travelFromPrevious: {
                  minutes: choice.minutes,
                  distanceM: choice.distanceM,
                  travelClass: travelClassFor(choice.minutes, choice.mode),
                },
                wayMode: choice.mode,
              }
              : {}),
            etaMinutes: entry.startMinutes,
            ...(entry.waitMinutes > 0 ? { waitMinutes: entry.waitMinutes } : {}),
            ...(entry.outsideHours || entry.lateMinutes > 0 ? { outsideHours: true } : {}),
          };
        }),
      };
    });
    if (windowStart === null || windowEnd === null) return { ...day, blocks };
    return {
      ...day,
      blocks,
      ...(day.breaks && day.breaks.length > 0
        ? { breaks: day.breaks.map((b) => (breakEtas.has(b.id) ? { ...b, etaMinutes: breakEtas.get(b.id) } : b)) }
        : {}),
      window: { startMinutes: windowStart, endMinutes: windowEnd },
      plannedMinutes: planned,
      waitMinutes: waited,
      freeMinutes: Math.max(0, windowMinutes - planned - waited),
      overrunMinutes: overrun,
    };
  });
}

/** A picked mode in force on this day: the segment's start and the choice, by its end. */
type Chosen = Map<string, { from: Coordinate; choice: SegmentChoice }>;

/**
 * The picked modes whose two ends stand next to each other on this day,
 * walked in the order the day times walk it: from the start of the day,
 * then from wherever each spot is left.
 */
function chosenSegments(
  day: StoredDay,
  start: Coordinate,
  segments: ReadonlyMap<string, SegmentChoice> | undefined,
): Chosen {
  const out: Chosen = new Map();
  if (!segments || segments.size === 0) return out;
  let fromRef = DAY_START;
  let from = start;
  const places = excursionPlaces(day.excursions);
  day.blocks.forEach((block, index) => {
    const at = blockStart(block.id, index > 0 ? day.blocks[index - 1].id : null, from, start, places);
    if (at !== from) {
      from = at;
      fromRef = DAY_START;
    }
    for (const stop of block.stops) {
      const choice = segments.get(segmentKey(fromRef, stop.osmRef));
      if (choice) out.set(stop.osmRef, { from, choice });
      fromRef = stop.osmRef;
      from = leaveFrom(stop);
    }
  });
  return out;
}

/**
 * The estimate, except on a segment with a picked mode, which takes the
 * minutes the router gave for it. Matched by the spot it goes to and
 * the point it leaves from, so the same spot reached from elsewhere is
 * estimated as usual.
 */
function travelWith(chosen: Chosen): (from: Coordinate, to: Coordinate, mode: TransportMode) => TravelLeg {
  return (from, to, mode) => {
    const ref = (to as Coordinate & { ref?: string }).ref;
    const hit = ref ? chosen.get(ref) : undefined;
    if (hit && Math.abs(hit.from.lat - from.lat) < 1e-9 && Math.abs(hit.from.lon - from.lon) < 1e-9) {
      return {
        minutes: hit.choice.minutes,
        distanceM: hit.choice.distanceM,
        travelClass: travelClassFor(hit.choice.minutes, hit.choice.mode),
      };
    }
    return travelLeg(from, to, mode);
  };
}
