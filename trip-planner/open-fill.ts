/**
 * "Tag füllen" (stage 8, step 2 of `reise-planen-und-unterwegs.md`):
 * which open spots of a stay a day could take.
 *
 * A proposal, never a decision: nothing here writes, and what comes
 * back is shown first. The spots it takes:
 *
 *   - are open that day (`opening-hours.ts`; hours nobody understands
 *     count as open, as in `suggest-day.ts`),
 *   - suit the weather: an outdoor spot stays off a rainy day when
 *     another coming day is drier,
 *   - fit the free time of the day, less the travel share the capacity
 *     line takes too (`OPEN_TRAVEL_SHARE`), Muss first, then Will,
 *     then Wenn Zeit,
 *   - and within one priority, the smallest detour from the day's own
 *     line first: from the lodging through what already stands on the
 *     day to where the day ends
 *     (`detour = d(a, spot) + d(spot, b) − d(a, b)`).
 *
 * Food is a break on the day, not a spot (`MEAL_CATEGORIES`), so it is
 * never proposed. Each pick says why it was taken, in the travellers'
 * words. Pure: no clock, no database.
 */

import { MEAL_CATEGORIES } from "./move";
import { OPEN_TRAVEL_SHARE } from "./open-capacity";
import { closedDates, openingOn } from "./opening-hours";
import type { IdeaPriority } from "./priority";
import { shelterOf } from "./shelter";
import type { Wetness } from "./stay-weather";
import { haversineMeters, type Coordinate } from "./travel";

/** A detour up to this counts as "on the way" and says so. */
export const ON_THE_WAY_M = 1_500;

export interface FillSpot extends Coordinate {
  osmRef: string;
  name: string;
  dwellMinutes: number;
  priority?: IdeaPriority;
  openingHours?: string | null;
  category: string;
  kind?: string | null;
}

/** What already stands on the day, in its order. */
export interface FillAnchor extends Coordinate {
  label: string;
  /** The hour of a fixed time; null for a stop without one. */
  fixedMinutes: number | null;
}

export interface FillDay {
  dayIndex: number;
  /** Null for a stay without dates: every day is open then. */
  date: string | null;
  start: Coordinate;
  end: Coordinate;
  anchors: readonly FillAnchor[];
  /** What the day has left, as `day-times.ts` reads it. */
  freeMinutes: number;
  /** No forecast: null. */
  wetness: Wetness | null;
  /** Another coming day of the stay has a drier forecast. */
  drierDayAhead: boolean;
  /** The other dates of the stay, for "heute geöffnet, Do zu". */
  otherDates: readonly string[];
}

export interface FillPick {
  osmRef: string;
  name: string;
  reasons: string[];
}

const RANK: Record<IdeaPriority, number> = { must: 0, want: 1, maybe: 2 };
const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/** The open spots this day would take, best first. */
export function pickForDay(day: FillDay, open: readonly FillSpot[]): FillPick[] {
  const rainy = (day.wetness ?? 0) > 0;
  const line: Array<Coordinate & { anchor?: FillAnchor }> = [
    day.start,
    ...day.anchors.map((anchor) => ({ lat: anchor.lat, lon: anchor.lon, anchor })),
    day.end,
  ];

  const ranked = open
    .filter((spot) => !MEAL_CATEGORIES.has(spot.category))
    .filter((spot) => !day.date || openingOn(spot.openingHours, day.date).state !== "closed")
    .filter((spot) => !(rainy && day.drierDayAhead && shelterOf(spot.category, spot.kind) === "outdoor"))
    .map((spot) => ({ spot, ...nearest(line, spot) }))
    .sort((a, b) =>
      RANK[a.spot.priority ?? "want"] - RANK[b.spot.priority ?? "want"]
      || a.detourM - b.detourM
      || (a.spot.osmRef < b.spot.osmRef ? -1 : a.spot.osmRef > b.spot.osmRef ? 1 : 0));

  const budget = Math.max(0, day.freeMinutes) * (1 - OPEN_TRAVEL_SHARE);
  let used = 0;
  const picks: FillPick[] = [];
  for (const { spot, detourM, before, after } of ranked) {
    const dwell = Math.max(0, spot.dwellMinutes);
    if (used + dwell > budget) continue;
    used += dwell;
    picks.push({ osmRef: spot.osmRef, name: spot.name, reasons: reasonsOf(day, spot, rainy, detourM, before, after) });
  }
  return picks;
}

/**
 * Take picks off the end until the day fits: the order search may find
 * that the ways or a closing hour make the estimate too hopeful. The
 * callback orders the day with these picks and says by how many
 * minutes it runs over.
 */
export function fitPicks(picks: readonly FillPick[], overrunWith: (refs: string[]) => number): FillPick[] {
  let kept = [...picks];
  while (kept.length > 0 && overrunWith(kept.map((pick) => pick.osmRef)) > 0) kept = kept.slice(0, -1);
  return kept;
}

function nearest(
  line: ReadonlyArray<Coordinate & { anchor?: FillAnchor }>,
  spot: Coordinate,
): { detourM: number; before: FillAnchor | null; after: FillAnchor | null } {
  let best = { detourM: Number.POSITIVE_INFINITY, before: null as FillAnchor | null, after: null as FillAnchor | null };
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const detourM = haversineMeters(a, spot) + haversineMeters(spot, b) - haversineMeters(a, b);
    if (detourM < best.detourM) best = { detourM, before: a.anchor ?? null, after: b.anchor ?? null };
  }
  return best;
}

function reasonsOf(
  day: FillDay,
  spot: FillSpot,
  rainy: boolean,
  detourM: number,
  before: FillAnchor | null,
  after: FillAnchor | null,
): string[] {
  const reasons: string[] = [];
  if (spot.priority === "must") reasons.push("Muss");
  if (detourM <= ON_THE_WAY_M) {
    // The way to a fixed time says more than the stop left behind.
    if (after && after.fixedMinutes !== null) reasons.push(`auf dem Weg zu ${after.label} ${clock(after.fixedMinutes)}`);
    else if (before) reasons.push(`nahe ${before.label}`);
    else if (after) reasons.push(`auf dem Weg zu ${after.label}`);
  }
  if (day.date) {
    const closed = closedDates(spot.openingHours, day.otherDates);
    if (closed.length > 0) reasons.push(`heute geöffnet, ${weekday(closed[0])} zu`);
  }
  if (rainy && shelterOf(spot.category, spot.kind) === "indoor") reasons.push("drinnen, falls es regnet");
  return reasons;
}

function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
