/**
 * Day trips as a chip of the spot picker
 * (`reise-planen-und-unterwegs.md`, stage 7, step 3).
 *
 * The old planner suggested one day trip when the stay's own pool did
 * not carry its days. A stay of ideas has no pool to measure: the
 * travellers fill it themselves, so the question "is the town enough?"
 * has no answer. What stays true is the other half: an hour away there
 * is a town worth a day. So the picker lists the places half an hour
 * to two hours away that hold enough for a day (the targets
 * `day-trip.ts` finds), and choosing one makes a day of the stay a day
 * out: the day's anchor moves there (`setTripDayAnchor`), and the
 * picker then searches around it for that day.
 *
 * Looking writes nothing. Accepting looks the place up again rather
 * than taking it from the request, for the reason `day-trip.ts` gives:
 * where a day happens is not something a client should state.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { IDEAS_DAY } from "./blocks";
import { setTripDayAnchor } from "./day-anchor-edit";
import {
  dayTargetsWithin,
  dismissedKeys,
  MAX_TRIP_TRAVEL_MINUTES,
  reachWithin,
  type DayTripTarget,
} from "./day-trip";
import { addDays } from "./leg-dates";
import { loadPlan, type StoredLeg } from "./plan-store";
import type { PlanResponse } from "./plans";
import { searchRadiusFor } from "./search-reach";
import { dayTripMode } from "./travel";
import { localToday } from "./stay-weather-api";
import { zoneAt } from "./time-zone";

/** Closer than this is part of the stay, not a day out. */
export const MIN_DAY_TRIP_MINUTES = 30;
/** A day of ideas: the one window `IDEAS_DAY` gives it. */
const DAY_MINUTES = IDEAS_DAY.reduce((sum, block) => sum + block.baseBudgetMinutes, 0);
/** The chip shows a handful, not the region. */
const MAX_TARGETS = 8;
/** Around the destination the picker searches as on foot: one town. */
export const DAY_TRIP_SEARCH_RADIUS_M = searchRadiusFor("foot");

export interface DayTripsRequest {
  planId: number;
  legIndex: number;
}

export interface DayTripsResponse {
  targets: DayTripTarget[];
  /** The day "+ Tag n" offers, or null when no day is free. */
  suggestedDayIndex: number | null;
  /** How far around a destination the picker searches. */
  searchRadiusM: number;
  /** Why the list is empty, in the traveller's words, or null. */
  note: string | null;
}

export const tripDayTrips = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/legs/:legIndex/day-trips", auth: true },
  async (req: DayTripsRequest): Promise<DayTripsResponse> => {
    const userId = requireUser();
    const leg = await legOf(req.planId, userId, req.legIndex);
    const found = await targetsOf(leg);
    return {
      targets: found.targets,
      suggestedDayIndex: suggestedTripDay(leg.days.map(dayOfLeg(leg)), leg.startDate === null ? null : todayAt(leg)),
      searchRadiusM: DAY_TRIP_SEARCH_RADIUS_M,
      note: found.note,
    };
  },
);

export interface AcceptDayTripsRequest {
  planId: number;
  legIndex: number;
  /** The destination as the list named it. */
  key: string;
  dayIndex: number;
}

export const acceptTripDayTrip = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/legs/:legIndex/day-trips/accept", auth: true },
  async (req: AcceptDayTripsRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const leg = await legOf(req.planId, userId, req.legIndex);
    if (!leg.days.some((day) => day.dayIndex === req.dayIndex)) {
      throw APIError.notFound(`day ${req.dayIndex} not found in leg ${req.legIndex}`);
    }
    const { targets } = await targetsOf(leg);
    const target = targets.find((t) => t.key === req.key);
    if (!target) throw APIError.failedPrecondition("dieses Ausflugsziel gibt es hier nicht mehr");
    // The organiser rule, the check and the re-plan live in the day
    // anchor call, as for a day trip set by hand.
    return await setTripDayAnchor({
      planId: req.planId,
      legIndex: leg.position,
      dayIndex: req.dayIndex,
      lat: target.lat,
      lon: target.lon,
      label: target.name,
    });
  },
);

/** What the suggestion of a day looks at. */
export interface TripDayFacts {
  dayIndex: number;
  /** ISO date, or null without one. */
  date: string | null;
  isDayTrip: boolean;
  stops: number;
}

/**
 * The day to offer: a coming day that is not a day trip already, the
 * one with the fewest spots; the first and the last day only when
 * nothing else is left, since arriving and leaving eat into them.
 */
export function suggestedTripDay(days: readonly TripDayFacts[], today: string | null): number | null {
  const sorted = [...days].sort((a, b) => a.dayIndex - b.dayIndex);
  const coming = sorted.filter((day) => !day.isDayTrip && (today === null || day.date === null || day.date >= today));
  if (coming.length === 0) return null;
  const first = sorted[0]?.dayIndex;
  const last = sorted[sorted.length - 1]?.dayIndex;
  const middle = sorted.length >= 3 ? coming.filter((day) => day.dayIndex !== first && day.dayIndex !== last) : [];
  const pool = middle.length > 0 ? middle : coming;
  return pool.reduce((best, day) => (day.stops < best.stops ? day : best)).dayIndex;
}

async function targetsOf(leg: StoredLeg): Promise<{ targets: DayTripTarget[]; note: string | null }> {
  if (leg.kind === "transit") return { targets: [], note: null };
  const region = await pickRegion(leg.anchor.lat, leg.anchor.lon);
  if (!region) return { targets: [], note: "Für diese Gegend ist noch keine Region importiert." };
  // A day out goes by car or train, whatever the stay does on foot.
  const mode = dayTripMode(leg.mode);
  const minRadiusM = reachWithin(leg.anchor, mode, MIN_DAY_TRIP_MINUTES);
  const maxRadiusM = reachWithin(leg.anchor, mode, MAX_TRIP_TRAVEL_MINUTES);
  if (maxRadiusM <= minRadiusM) return { targets: [], note: "In Tagesausflug-Nähe liegt nichts." };

  let page;
  try {
    page = await getGeoClient().searchDayTargets(region.postgresDb, {
      center: { lat: leg.anchor.lat, lon: leg.anchor.lon },
      minRadiusM,
      maxRadiusM,
    });
  } catch {
    throw APIError.unavailable("die Region antwortet gerade nicht");
  }
  const refused = await dismissedKeys(leg.id);
  const targets = dayTargetsWithin(page.targets, leg.anchor, mode, DAY_MINUTES, refused, MIN_DAY_TRIP_MINUTES)
    .slice(0, MAX_TARGETS);
  return {
    targets,
    note: targets.length === 0 ? "In einer halben bis zwei Stunden liegt nichts, was einen ganzen Tag trägt." : null,
  };
}

function dayOfLeg(leg: StoredLeg): (day: StoredLeg["days"][number]) => TripDayFacts {
  return (day) => ({
    dayIndex: day.dayIndex,
    date: leg.startDate === null ? null : addDays(leg.startDate, day.dayIndex),
    isDayTrip: day.anchor !== null,
    stops: day.blocks.reduce((sum, block) => sum + block.stops.length, 0),
  });
}

function todayAt(leg: StoredLeg): string {
  return localToday(zoneAt(leg.anchor), new Date());
}

async function legOf(planId: number, userId: number, legIndex: number): Promise<StoredLeg> {
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.notFound("plan not found");
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
