/**
 * The measurement §24 asks for before the router may shape the plan
 * (stage 2): the estimate next to the router, on the caller's own
 * trips rather than on pairs somebody has to type in.
 *
 * Every day is walked the way the planner walks it — from the day's
 * anchor (or the leg's) through the stops in block order and back —
 * and each hop is asked of the router once. What comes back is a
 * verdict per mode: how often the estimate is off by more than a
 * quarter, and the hops where it is off the most, so the admin can see
 * *where* and not only *how much*.
 */

import { and, asc, desc, eq, ne } from "drizzle-orm";
import dbDefault from "../db/database";
import { tripPlanBlocks, tripPlanDays, tripPlanLegs, tripPlans, tripPlanStops } from "../db/schema";
import type { RouterClient } from "./router-client";
import { travelLeg, type Coordinate, type TransportMode } from "./travel";

type Db = typeof dbDefault;

/** One hop of a planned day, with names so a bad one can be found again. */
export interface MeasurePair {
  mode: TransportMode;
  from: Coordinate & { label: string };
  to: Coordinate & { label: string };
  planTitle: string | null;
}

export interface MeasureSample extends MeasurePair {
  estimateMinutes: number;
  /** Null when the router found no way. */
  routerMinutes: number | null;
}

export interface ModeSummary {
  mode: TransportMode;
  /** Hops asked. */
  pairs: number;
  /** Hops the router answered. */
  answered: number;
  /** Hops where estimate and router differ by more than a quarter (and at least MIN_MINUTES). */
  offByQuarter: number;
  /** Median of |router − estimate| / router, in percent. Null without answers. */
  medianDeviationPct: number | null;
  /** Median of router − estimate, in minutes; positive when the estimate is optimistic. */
  medianDifferenceMinutes: number | null;
}

export interface WorstPair {
  mode: TransportMode;
  from: string;
  to: string;
  planTitle: string | null;
  estimateMinutes: number;
  routerMinutes: number;
}

export interface MeasureResult {
  modes: ModeSummary[];
  worst: WorstPair[];
  /** True when the estimate is off by more than a quarter on at least a quarter of the answered hops. */
  worthwhile: boolean;
}

/** At most this many hops per run: enough for a verdict, cheap for the router. */
export const MAX_PAIRS = 80;
/** A difference below this is noise, whatever the percentage says (a 2-minute walk vs. 3). */
export const MIN_MINUTES = 3;
const QUARTER = 0.25;
const CONCURRENCY = 4;

/** Transit is not asked: the router has no timetable yet (§24, stage 3). */
const MEASURED: ReadonlySet<string> = new Set(["foot", "bike", "car"]);

function isOff(estimate: number, routed: number): boolean {
  const diff = Math.abs(routed - estimate);
  return diff >= MIN_MINUTES && diff > QUARTER * Math.max(routed, 1);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The verdict from the samples alone — pure, so it can be tested without a router. */
export function summarize(samples: readonly MeasureSample[]): MeasureResult {
  const byMode = new Map<TransportMode, MeasureSample[]>();
  for (const s of samples) byMode.set(s.mode, [...(byMode.get(s.mode) ?? []), s]);

  const modes: ModeSummary[] = [...byMode.entries()].map(([mode, list]) => {
    const answered = list.filter((s): s is MeasureSample & { routerMinutes: number } => s.routerMinutes !== null);
    return {
      mode,
      pairs: list.length,
      answered: answered.length,
      offByQuarter: answered.filter((s) => isOff(s.estimateMinutes, s.routerMinutes)).length,
      medianDeviationPct: roundOrNull(median(answered.map((s) =>
        (Math.abs(s.routerMinutes - s.estimateMinutes) / Math.max(s.routerMinutes, 1)) * 100))),
      medianDifferenceMinutes: roundOrNull(median(answered.map((s) => s.routerMinutes - s.estimateMinutes))),
    };
  });

  const worst = samples
    .filter((s): s is MeasureSample & { routerMinutes: number } =>
      s.routerMinutes !== null && isOff(s.estimateMinutes, s.routerMinutes))
    .sort((a, b) => Math.abs(b.routerMinutes - b.estimateMinutes) - Math.abs(a.routerMinutes - a.estimateMinutes))
    .slice(0, 5)
    .map((s) => ({
      mode: s.mode,
      from: s.from.label,
      to: s.to.label,
      planTitle: s.planTitle,
      estimateMinutes: s.estimateMinutes,
      routerMinutes: s.routerMinutes,
    }));

  const answeredTotal = modes.reduce((n, m) => n + m.answered, 0);
  const offTotal = modes.reduce((n, m) => n + m.offByQuarter, 0);
  return { modes, worst, worthwhile: answeredTotal > 0 && offTotal >= QUARTER * answeredTotal };
}

function roundOrNull(v: number | null): number | null {
  return v === null ? null : Math.round(v);
}

function key(c: Coordinate): string {
  return `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
}

/**
 * The hops of the owner's planned days, newest plan first, each pair
 * once. Transit legs (the journey between cities) and transit mode are
 * left out; so is a hop between two points in the same place.
 */
export async function collectPairs(ownerId: number, limit = MAX_PAIRS, db: Db = dbDefault): Promise<MeasurePair[]> {
  const rows = await db
    .select({
      planId: tripPlans.id,
      planTitle: tripPlans.title,
      dayId: tripPlanDays.id,
      mode: tripPlanLegs.mode,
      legLat: tripPlanLegs.anchor_lat,
      legLon: tripPlanLegs.anchor_lon,
      legLabel: tripPlanLegs.anchor_label,
      legTitle: tripPlanLegs.title,
      dayLat: tripPlanDays.anchor_lat,
      dayLon: tripPlanDays.anchor_lon,
      dayLabel: tripPlanDays.anchor_label,
      stopLat: tripPlanStops.lat,
      stopLon: tripPlanStops.lon,
      stopName: tripPlanStops.name,
      stopCategory: tripPlanStops.category,
      branchId: tripPlanStops.branch_id,
    })
    .from(tripPlanStops)
    .innerJoin(tripPlanBlocks, eq(tripPlanBlocks.id, tripPlanStops.block_id))
    .innerJoin(tripPlanDays, eq(tripPlanDays.id, tripPlanBlocks.day_id))
    .innerJoin(tripPlanLegs, eq(tripPlanLegs.id, tripPlanDays.leg_id))
    .innerJoin(tripPlans, eq(tripPlans.id, tripPlanLegs.plan_id))
    .where(and(eq(tripPlans.owner_id, ownerId), ne(tripPlanLegs.kind, "transit")))
    .orderBy(
      desc(tripPlans.updated_at),
      asc(tripPlans.id),
      asc(tripPlanLegs.position),
      asc(tripPlanDays.day_index),
      asc(tripPlanBlocks.position),
      asc(tripPlanStops.position),
    );

  // Group into days, keeping the order the query gave.
  const days = new Map<number, typeof rows>();
  for (const r of rows) {
    // A split's branches walk their own ways; the group's way is the one
    // the planner estimates as a chain.
    if (r.branchId !== null) continue;
    days.set(r.dayId, [...(days.get(r.dayId) ?? []), r]);
  }

  const pairs: MeasurePair[] = [];
  const seen = new Set<string>();
  for (const stops of days.values()) {
    const first = stops[0];
    if (!MEASURED.has(first.mode)) continue;
    const mode = first.mode as TransportMode;
    const anchor = first.dayLat !== null && first.dayLon !== null
      ? { lat: first.dayLat, lon: first.dayLon, label: first.dayLabel ?? "Tagesstart" }
      : { lat: first.legLat, lon: first.legLon, label: first.legLabel ?? first.legTitle ?? "Unterkunft" };
    const chain = [
      anchor,
      ...stops.map((s) => ({ lat: s.stopLat, lon: s.stopLon, label: s.stopName ?? s.stopCategory })),
      anchor,
    ];
    for (let i = 1; i < chain.length; i++) {
      const from = chain[i - 1];
      const to = chain[i];
      if (key(from) === key(to)) continue;
      const id = `${mode}|${key(from)}>${key(to)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      pairs.push({ mode, from, to, planTitle: first.planTitle });
      if (pairs.length >= limit) return pairs;
    }
  }
  return pairs;
}

/** Each pair asked of the router, a few at a time; the estimate beside it. */
export async function measurePairs(pairs: readonly MeasurePair[], router: RouterClient): Promise<MeasureSample[]> {
  const samples: MeasureSample[] = new Array(pairs.length);
  let next = 0;
  async function worker() {
    while (next < pairs.length) {
      const i = next++;
      const p = pairs[i];
      const routed = await router.route(p.from, p.to, p.mode);
      samples[i] = {
        ...p,
        estimateMinutes: travelLeg(p.from, p.to, p.mode).minutes,
        routerMinutes: routed?.minutes ?? null,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, worker));
  return samples;
}
