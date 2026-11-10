/**
 * The best light of one spot on each day of its stay
 * (`reise-planen-und-unterwegs.md`, stage 7, step 2).
 *
 * The old evening suggestion framed the last block of a day around a
 * marked photo stop. A day of ideas has one window and no last block,
 * so the light moves to where the spot is looked at: its details show
 * the evening's golden hour on every day of the stay, with the clouds
 * where a forecast reaches, and "+ Tag n am Abend" makes it a spot with
 * a fixed time whose reason is the light. Accepting is the ordinary
 * fixed time (`POST …/fixpoints`); the plan then puts the spot on that
 * day at that hour, wherever it was before.
 *
 * Which spot has a light worth showing: one marked as a photo stop, a
 * viewpoint, or a facade whose direction is known. Everything else
 * answers `applies: false`, and the details show nothing.
 */

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { addDays } from "./leg-dates";
import { spotLight, type FacadeLight } from "./light";
import { lightWindows } from "./sun";
import { horizonFor } from "./horizon-store";
import { loadPlan, removeFixpoint, type StoredLeg, type StoredPlan } from "./plan-store";
import { addTripFixpoint } from "./fixpoint-edit";
import { requireOrganiser } from "./plan-access";
import { placeFromPool } from "./pool";
import { applyStopMoves, localToday } from "./stay-weather-api";
import type { PlanResponse } from "./plans";
import { offsetMinutes, zoneAt } from "./time-zone";
import { forecastFor } from "./weather-service";

/** An evening window starts after this, in minutes of the day. */
const EVENING_FROM_MINUTES = 14 * 60;
/** Shorter than this is not worth going out for. */
const MIN_WINDOW_MINUTES = 15;
/** Mean cloud cover from which the light is likely lost. */
export const CLOUDY_PERCENT = 75;

export interface SpotLightDay {
  dayIndex: number;
  date: string;
  fromMinutes: number;
  toMinutes: number;
  /** How the sun meets the facade, when its direction is known. */
  facade: FacadeLight | null;
  /** Mean cloud cover in the window, null beyond the forecast. */
  cloudCover: number | null;
  cloudy: boolean;
  /** The day is over. */
  past: boolean;
}

export interface SpotLightRequest {
  planId: number;
  legIndex: number;
  osmRef: Query<string>;
}

export interface SpotLightResponse {
  /** False for a spot whose light nobody asked about. */
  applies: boolean;
  days: SpotLightDay[];
  /** The day "+ Tag n am Abend" offers, or null. */
  suggestedDayIndex: number | null;
  /** The day the spot is planned on now, or null while it is an idea. */
  onDayIndex: number | null;
  /** The day its light is already the fixed time of, or null. */
  fixedDayIndex: number | null;
}

interface LightSpot {
  osmRef: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  kind?: string | null;
  photoStop?: boolean;
  facadeAzimuth?: number | null;
  dwellMinutes: number;
}

export const tripSpotLight = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/legs/:legIndex/spot-light", auth: true },
  async (req: SpotLightRequest): Promise<SpotLightResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = legOf(plan, req.legIndex);
    return await lightOf(leg, spotOf(leg, req.osmRef));
  },
);

export interface AcceptSpotLightRequest {
  planId: number;
  legIndex: number;
  osmRef: string;
  dayIndex: number;
}

export const acceptTripSpotLight = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/legs/:legIndex/spot-light/accept", auth: true },
  async (req: AcceptSpotLightRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Feste Zeiten");
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = legOf(plan, req.legIndex);
    const spot = spotOf(leg, req.osmRef);
    const held = leg.days.flatMap((d) => d.fixpoints)
      .find((f) => f.spotRef === spot.osmRef && !f.blockId && f.pinReason !== "light");
    if (held) {
      // A ticket or a table already fixes the hour; the light does not
      // get to move it.
      throw APIError.failedPrecondition(`„${spot.name}" hat schon eine feste Zeit: ${held.label}`);
    }
    // Recomputed, not trusted: the window has to be there today.
    const light = await lightOf(leg, spot);
    const day = light.days.find((d) => d.dayIndex === req.dayIndex && !d.past);
    if (!light.applies || !day) {
      throw APIError.failedPrecondition("an diesem Tag gibt es für diesen Spot kein Abendlicht");
    }

    // One fixed time per spot: the light on Thursday replaces an
    // earlier one on Tuesday, or the plan would not know where it goes.
    for (const other of leg.days) {
      for (const fix of other.fixpoints) {
        if (fix.spotRef === spot.osmRef && !fix.blockId && fix.pinReason === "light") await removeFixpoint(plan.id, userId, fix.rowId);
      }
    }
    // The spot goes onto that day first: a fixed time does not fetch an
    // idea out of the list on a trip of ideas, and a fixed time on a day
    // the spot is not on would be a ticket for nothing.
    if (leg.pool.some((c) => c.osmRef === spot.osmRef)) {
      await placeFromPool({ planId: plan.id, legIndex: leg.position, dayIndex: day.dayIndex, osmRef: spot.osmRef });
    } else if (light.onDayIndex !== day.dayIndex) {
      const now = await loadPlan(plan.id, userId);
      if (now) await applyStopMoves(now, legOf(now, leg.position), [{ osmRef: spot.osmRef, toDayIndex: day.dayIndex }]);
    }
    const start = startFor(day, spot.dwellMinutes);
    return await addTripFixpoint({
      planId: plan.id,
      legIndex: leg.position,
      dayIndex: day.dayIndex,
      label: spot.name,
      at: clock(start),
      durationMinutes: day.toMinutes - start,
      spotRef: spot.osmRef,
      pinReason: "light",
      lat: spot.lat,
      lon: spot.lon,
    });
  },
);

/**
 * When to be there: at the window's start, or earlier for a long visit
 * so its last half hour is the golden one.
 */
export function startFor(day: Pick<SpotLightDay, "fromMinutes" | "toMinutes">, dwellMinutes: number): number {
  const window = day.toMinutes - day.fromMinutes;
  return day.fromMinutes - Math.max(0, Math.min(dwellMinutes, 120) - window);
}

/** Does this spot have a light worth showing? */
export function wantsLight(spot: Pick<LightSpot, "photoStop" | "category" | "kind" | "facadeAzimuth">): boolean {
  return spot.photoStop === true
    || spot.category === "viewpoint"
    || spot.kind === "tourism=viewpoint"
    || (typeof spot.facadeAzimuth === "number" && Number.isFinite(spot.facadeAzimuth));
}

/**
 * The day to offer: the one it is planned on unless that one is
 * cloudy, else the clearest coming day, else the first coming day.
 */
export function suggestedDay(days: readonly SpotLightDay[], onDayIndex: number | null): number | null {
  const coming = days.filter((d) => !d.past);
  if (coming.length === 0) return null;
  const on = coming.find((d) => d.dayIndex === onDayIndex);
  if (on && !on.cloudy) return on.dayIndex;
  const clear = coming
    .filter((d) => !d.cloudy && d.cloudCover !== null)
    .sort((a, b) => a.cloudCover! - b.cloudCover! || a.dayIndex - b.dayIndex);
  if (clear.length > 0) return clear[0].dayIndex;
  return (coming.find((d) => !d.cloudy) ?? coming[0]).dayIndex;
}

async function lightOf(leg: StoredLeg, spot: LightSpot, now: Date = new Date()): Promise<SpotLightResponse> {
  const onDay = leg.days.find((day) => day.blocks.some((b) => b.stops.some((s) => s.osmRef === spot.osmRef)));
  const fixed = leg.days.find((day) => day.fixpoints.some((f) => f.spotRef === spot.osmRef && f.pinReason === "light"));
  const base = {
    onDayIndex: onDay?.dayIndex ?? null,
    fixedDayIndex: fixed?.dayIndex ?? null,
  };
  const startDate = leg.startDate;
  if (!wantsLight(spot) || startDate === null) {
    return { applies: wantsLight(spot), days: [], suggestedDayIndex: null, ...base };
  }

  const zone = zoneAt(spot);
  const today = localToday(zone, now);
  const at = { lat: spot.lat, lon: spot.lon };
  const horizon = await horizonFor(at);
  const dates = leg.days.map((day) => addDays(startDate, day.dayIndex));
  const { byDay } = await forecastFor(at, [...new Set(dates.flatMap((d) => [d, addDays(d, 1)]))], now);
  const hours = [...byDay.values()].flat();

  const days: SpotLightDay[] = [];
  for (const day of leg.days) {
    const date = addDays(startDate, day.dayIndex);
    const offset = (zone ? offsetMinutes(zone, date) : null) ?? 0;
    const best = spotLight(at, lightWindows(at, date, offset, horizon), spot.facadeAzimuth)
      .find(({ window }) => window.kind === "golden"
        && window.fromMinutes >= EVENING_FROM_MINUTES
        && window.toMinutes - window.fromMinutes >= MIN_WINDOW_MINUTES);
    if (!best) continue;
    const from = Date.parse(best.window.from);
    const to = Date.parse(best.window.to);
    const covering = hours.filter((hour) => {
      const t = Date.parse(hour.time);
      return t + 3_600_000 > from && t < to;
    });
    const cloudCover = covering.length > 0
      ? Math.round(covering.reduce((sum, hour) => sum + hour.cloudCover, 0) / covering.length)
      : null;
    days.push({
      dayIndex: day.dayIndex,
      date,
      fromMinutes: best.window.fromMinutes,
      toMinutes: best.window.toMinutes,
      facade: best.facade,
      cloudCover,
      cloudy: cloudCover !== null && cloudCover >= CLOUDY_PERCENT,
      past: date < today,
    });
  }
  return { applies: true, days, suggestedDayIndex: suggestedDay(days, base.onDayIndex), ...base };
}

function spotOf(leg: StoredLeg, osmRef: string): LightSpot {
  const ref = osmRef.trim();
  const idea = leg.pool.find((c) => c.osmRef === ref);
  const stop = idea ? null : leg.days.flatMap((d) => d.blocks.flatMap((b) => b.stops)).find((s) => s.osmRef === ref);
  const spot = idea ?? stop;
  if (!spot) throw APIError.notFound("dieser Spot gehört nicht zu diesem Aufenthalt");
  return {
    osmRef: ref,
    name: (stop?.title ?? spot.name) || "Spot",
    lat: spot.lat,
    lon: spot.lon,
    category: spot.category,
    kind: spot.kind ?? null,
    photoStop: spot.photoStop,
    facadeAzimuth: spot.facadeAzimuth ?? null,
    dwellMinutes: spot.dwellMinutes,
  };
}

function clock(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function legOf(plan: StoredPlan, legIndex: number): StoredLeg {
  const leg = plan.legs.find((candidate) => candidate.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
  return leg;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
