/**
 * The way between two places (reise-planen-und-unterwegs.md, stage 6):
 * the sheet "Weg", the streets on the day map, and a mode picked for
 * one segment.
 *
 * Three endpoints:
 *
 *   - `POST /trip-planner/routing/way` — from, to and the modes to
 *     compare; per mode the minutes, the metres and the line along the
 *     streets. With `check` it also says whether the arrival fits the
 *     opening hours and a booked time of the place it goes to.
 *   - `GET …/legs/:legIndex/days/:dayIndex/ways` — every segment of a
 *     day, from the start of the day to the first spot and on from spot
 *     to spot, routed in the segment's mode.
 *   - `POST /trip-planner/plans/:planId/segments` — the mode for one
 *     segment; the day times use its minutes from then on.
 *
 * Routing goes through Valhalla (`router-client.ts`) for foot, bike and
 * car. Public transport has no timetable there, so it stays the
 * estimate (`travelLeg`), drawn as a straight line; where walking is
 * quicker than the tram, the hop is walked and routed as such. Every
 * answer is kept in `trip_route_cache`, so after a reorder only the new
 * segments reach the router. A router that is away is never an error:
 * the estimate stands in, with `routed: false`.
 */

import { api, APIError } from "encore.dev/api";
import { and, eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import dbDefault from "../db/database";
import { tripPlanSegments, tripRouteCache } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { frameOf } from "./day-times";
import { leaveFrom } from "./extent";
import { addDays } from "./leg-dates";
import { openingOn, windowText } from "./opening-hours";
import { loadPlan, type StoredDay, type StoredLeg, type StoredPlan } from "./plan-store";
import { costingFor, getRouterClient } from "./router-client";
import { DAY_START, WAY_MODES, loadSegmentChoices, segmentKey } from "./segments";
import { travelLeg, type Coordinate, type TransportMode } from "./travel";

type Db = typeof dbDefault;

/** How long a cached answer is trusted; tiles are rebuilt rarely. */
const CACHE_DAYS = 90;

export interface Way {
  /** The mode asked for. */
  mode: TransportMode;
  /** The mode it is actually done in: a transit hop that is walked says "foot". */
  by: TransportMode;
  minutes: number;
  distanceM: number;
  /** Encoded polyline, precision 6; null for an estimate. */
  shape: string | null;
  /** False when the router had no answer and this is the estimate. */
  routed: boolean;
}

/** Both ends to five places (about a metre) and the mode. */
export function routeCacheKey(from: Coordinate, to: Coordinate, mode: TransportMode): string {
  const p = (c: Coordinate) => `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  return `${mode}:${p(from)}:${p(to)}`;
}

/** The way in one mode: the cache, the router, else the estimate. */
export async function wayFor(
  from: Coordinate,
  to: Coordinate,
  mode: TransportMode,
  db: Db = dbDefault,
): Promise<Way> {
  const estimate = travelLeg(from, to, mode);
  // A transit hop walked because walking is quicker (travel.ts) is a walk.
  const by: TransportMode = mode === "transit" && estimate.travelClass.endsWith("walk") ? "foot" : mode;
  if (!costingFor(by)) {
    return { mode, by, minutes: estimate.minutes, distanceM: estimate.distanceM, shape: null, routed: false };
  }
  const key = routeCacheKey(from, to, by);
  const [cached] = await db.select().from(tripRouteCache).where(eq(tripRouteCache.key, key)).limit(1);
  if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_DAYS * 86_400_000) {
    return { mode, by, minutes: cached.minutes, distanceM: cached.distance_m, shape: cached.shape, routed: true };
  }
  const routed = await getRouterClient().route(from, to, by);
  if (!routed) {
    const fallback = by === mode ? estimate : travelLeg(from, to, by);
    return { mode, by, minutes: fallback.minutes, distanceM: fallback.distanceM, shape: null, routed: false };
  }
  const row = { mode: by, minutes: routed.minutes, distance_m: routed.distanceM, shape: routed.shape };
  await db
    .insert(tripRouteCache)
    .values({ key, ...row })
    .onConflictDoUpdate({ target: tripRouteCache.key, set: { ...row, created_at: new Date().toISOString() } });
  return { mode, by, minutes: routed.minutes, distanceM: routed.distanceM, shape: routed.shape, routed: true };
}

/** One segment of a day: from the start or a spot to the next spot. */
export interface DaySegment {
  fromRef: string;
  toRef: string;
  from: Coordinate;
  to: Coordinate;
}

/** The day's segments in order, across its blocks, as the day times walk them. */
export function segmentsOfDay(day: StoredDay, legAnchor: Coordinate): DaySegment[] {
  let fromRef = DAY_START;
  let from: Coordinate = day.anchor ? { lat: day.anchor.lat, lon: day.anchor.lon } : legAnchor;
  const out: DaySegment[] = [];
  for (const block of day.blocks) {
    for (const stop of block.stops) {
      out.push({ fromRef, toRef: stop.osmRef, from, to: { lat: stop.lat, lon: stop.lon } });
      fromRef = stop.osmRef;
      from = leaveFrom(stop);
    }
  }
  return out;
}

// ── POST /trip-planner/routing/way ──────────────────────────────────

export interface WayCheck {
  planId: number;
  legIndex: number;
  dayIndex: number;
  /** The spot the way goes to. */
  osmRef: string;
  /** When the group sets off, minutes after midnight. */
  departMinutes: number;
}

export interface WayRequest {
  from: Coordinate;
  to: Coordinate;
  /** Defaults to all four. */
  modes?: TransportMode[];
  check?: WayCheck;
}

/**
 * How the arrival fits the place: open, waiting at the door, closed by
 * then or for the day, too late for the booked time; null when the
 * opening hours are unknown and nothing is booked.
 */
export type ArrivalFit = "open" | "before_opening" | "after_closing" | "closed_day" | "after_ticket";

export interface CheckedWay extends Way {
  /** Only with `check`. */
  arriveMinutes?: number;
  fit?: ArrivalFit | null;
}

export interface WayResponse {
  ways: CheckedWay[];
  /** With `check`: the place's hours that day ("10:00–18:00") and its booked time. */
  target?: { openingText: string | null; ticketMinutes: number | null };
}

export const tripWay = api(
  { expose: true, method: "POST", path: "/trip-planner/routing/way", auth: true },
  async (req: WayRequest): Promise<WayResponse> => {
    const userId = requireUser();
    requireCoordinate("from", req.from);
    requireCoordinate("to", req.to);
    const modes = req.modes && req.modes.length > 0 ? [...new Set(req.modes)] : [...WAY_MODES];
    for (const m of modes) requireMode(m);
    const ways = await Promise.all(modes.map((m) => wayFor(req.from, req.to, m)));
    if (!req.check) return { ways };

    const { check } = req;
    if (!Number.isInteger(check.departMinutes) || check.departMinutes < 0 || check.departMinutes > 1439) {
      throw APIError.invalidArgument("departMinutes must be a minute of the day");
    }
    const { leg, day } = await dayOf(check.planId, check.legIndex, check.dayIndex, userId);
    const target = targetOf(leg, day, check.osmRef);
    return {
      ways: ways.map((w) => {
        const arrive = check.departMinutes + w.minutes;
        return { ...w, arriveMinutes: arrive, fit: arrivalFit(arrive, target) };
      }),
      target: {
        openingText: target.opening.state === "open" ? target.opening.windows.map(windowText).join(", ") : null,
        ticketMinutes: target.ticketMinutes,
      },
    };
  },
);

interface Target {
  opening: ReturnType<typeof openingOn>;
  ticketMinutes: number | null;
}

function targetOf(leg: StoredLeg, day: StoredDay, osmRef: string): Target {
  const block = day.blocks.find((b) => b.stops.some((s) => s.osmRef === osmRef));
  const stop = block?.stops.find((s) => s.osmRef === osmRef);
  const date = leg.startDate ? addDays(leg.startDate, day.dayIndex) : null;
  const opening = stop && date ? openingOn(stop.openingHours ?? null, date) : { state: "unknown" as const };
  const ticketMinutes = block ? frameOf(block, day.fixpoints)?.tickets.get(osmRef) ?? null : null;
  return { opening, ticketMinutes };
}

/** Pure: an arrival against the place's hours and its booked time. */
export function arrivalFit(arriveMinutes: number, target: Target): ArrivalFit | null {
  if (target.ticketMinutes !== null && arriveMinutes > target.ticketMinutes) return "after_ticket";
  const opening = target.opening;
  if (opening.state === "closed") return "closed_day";
  if (opening.state === "unknown") return null;
  if (opening.windows.some((w) => arriveMinutes >= w.from && arriveMinutes < w.to)) return "open";
  if (opening.windows.some((w) => arriveMinutes < w.from)) return "before_opening";
  return "after_closing";
}

// ── GET …/days/:dayIndex/ways ───────────────────────────────────────

export interface DayWaysRequest {
  planId: number;
  legIndex: number;
  dayIndex: number;
}

export interface DayWay extends Way {
  fromRef: string;
  toRef: string;
  from: Coordinate;
  to: Coordinate;
  /** A mode somebody picked for this segment, rather than the stay's. */
  chosen: boolean;
}

export interface DayWaysResponse {
  ways: DayWay[];
}

export const tripDayWays = api(
  {
    expose: true,
    method: "GET",
    path: "/trip-planner/plans/:planId/legs/:legIndex/days/:dayIndex/ways",
    auth: true,
  },
  async (req: DayWaysRequest): Promise<DayWaysResponse> => {
    const userId = requireUser();
    const { plan, leg, day } = await dayOf(req.planId, req.legIndex, req.dayIndex, userId);
    const choices = await loadSegmentChoices(plan.id);
    const ways = await Promise.all(
      segmentsOfDay(day, leg.anchor).map(async (seg) => {
        const choice = choices.get(segmentKey(seg.fromRef, seg.toRef));
        const mode = choice?.mode ?? wayModeOf(leg.mode);
        const way = await wayFor(seg.from, seg.to, mode);
        return { ...seg, ...way, chosen: choice !== undefined };
      }),
    );
    return { ways };
  },
);

/** The stay's mode as a way mode; a ship or a plane stay walks on land. */
function wayModeOf(mode: TransportMode): TransportMode {
  return (WAY_MODES as readonly string[]).includes(mode) ? mode : "foot";
}

// ── POST /trip-planner/plans/:planId/segments ───────────────────────

export interface SegmentModeRequest {
  planId: number;
  fromRef: string;
  toRef: string;
  /** Null goes back to the stay's mode. */
  mode: TransportMode | null;
  /** Where the segment runs, to route it; required with a mode. */
  from?: Coordinate;
  to?: Coordinate;
}

export interface SegmentModeResponse {
  plan: StoredPlan;
}

export const setTripSegmentMode = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/segments", auth: true },
  async (req: SegmentModeRequest): Promise<SegmentModeResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const fromRef = req.fromRef?.trim() ?? "";
    const toRef = req.toRef?.trim() ?? "";
    if (fromRef.length === 0 || toRef.length === 0) throw APIError.invalidArgument("fromRef and toRef are required");
    const known = new Set(plan.legs.flatMap((l) => l.days.flatMap((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)))));
    if (!known.has(toRef) || (fromRef !== DAY_START && !known.has(fromRef))) {
      throw APIError.notFound("no such segment on this trip");
    }

    if (req.mode === null) {
      await dbDefault
        .delete(tripPlanSegments)
        .where(and(eq(tripPlanSegments.plan_id, plan.id), eq(tripPlanSegments.from_ref, fromRef), eq(tripPlanSegments.to_ref, toRef)));
    } else {
      requireMode(req.mode);
      if (!req.from || !req.to) throw APIError.invalidArgument("from and to are required with a mode");
      requireCoordinate("from", req.from);
      requireCoordinate("to", req.to);
      const way = await wayFor(req.from, req.to, req.mode);
      const row = { mode: req.mode, minutes: way.minutes, distance_m: way.distanceM, updated_at: new Date().toISOString() };
      await dbDefault
        .insert(tripPlanSegments)
        .values({ plan_id: plan.id, from_ref: fromRef, to_ref: toRef, ...row })
        .onConflictDoUpdate({
          target: [tripPlanSegments.plan_id, tripPlanSegments.from_ref, tripPlanSegments.to_ref],
          set: row,
        });
    }
    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while setting a way");
    return { plan: updated };
  },
);

// ── helpers ─────────────────────────────────────────────────────────

async function dayOf(planId: number, legIndex: number, dayIndex: number, userId: number) {
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.notFound("plan not found");
  const leg = plan.legs.find((l) => l.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
  const day = leg.days.find((d) => d.dayIndex === dayIndex);
  if (!day) throw APIError.notFound(`day ${dayIndex} not found in this leg`);
  return { plan, leg, day };
}

function requireMode(mode: string): void {
  if (!(WAY_MODES as readonly string[]).includes(mode)) {
    throw APIError.invalidArgument(`mode must be one of ${WAY_MODES.join(", ")}`);
  }
}

function requireCoordinate(label: string, p: Coordinate | undefined): void {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
    throw APIError.invalidArgument(`${label} is not a coordinate`);
  }
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
