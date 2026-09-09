/**
 * Afterwards (§8.7).
 *
 * "Geplant gegen tatsächlich besucht, Fotos je Spot aus dem Trip-Album,
 * Übergabe an den Recap." Two of those three are answerable from rows
 * that already exist, and this puts them on one screen.
 *
 * The interesting half is not the tick list. A plan that was followed
 * exactly is the boring case; what a trip actually produces is the
 * **unplanned stays** — the place somebody wandered into, which the
 * visit diary keeps precisely because it is the more valuable half
 * (§6.4, and the column comment on `trip_plan_visits.stop_id`). They
 * are listed beside the planned stops rather than under them.
 *
 * Photos come from `photo_poi_matches`: the matcher already ties a
 * photo to an OpenStreetMap reference, which is the same key a stop
 * carries. So "how many photos of this spot" is a join, not a new
 * pipeline — and it is deliberately restricted to the traveller's own
 * photos taken inside the trip's dates. A photograph of the same church
 * from a holiday three years ago is not a picture of this trip.
 *
 * The recap handover is **not** here. Recaps are built from GPS
 * clusters over a user's library (`docs/recaps.md`), and a planned trip
 * does not yet reach that pipeline; claiming a link that does not exist
 * would be worse than saying so, which the response does.
 */

import { api, APIError } from "encore.dev/api";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { photoPoiMatches, photos } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { addDays } from "./leg-dates";
import { loadPlan, type StoredLeg } from "./plan-store";
import { listVisits, type StoredVisit } from "./visit-store";

export interface ReviewStop {
  legIndex: number;
  dayIndex: number;
  /** The date this day fell on, or null for a trip without dates. */
  date: string | null;
  osmRef: string;
  name: string | null;
  /** planned | done | skipped — what the day plan says about it. */
  status: string;
  /** True when the visit diary confirms it, whatever the status says. */
  visited: boolean;
  /** Photos of this spot taken during the trip, by this traveller. */
  photos: number;
}

export interface ReviewUnplanned {
  name: string | null;
  osmRef: string | null;
  lat: number;
  lon: number;
  arrivedAt: string;
  photos: number;
}

export interface ReviewTotals {
  planned: number;
  done: number;
  skipped: number;
  /** Planned, not ticked off, and no visit recorded either. */
  untouched: number;
  unplanned: number;
  photos: number;
}

export interface TripReviewResponse {
  startsOn: string | null;
  endsOn: string | null;
  stops: ReviewStop[];
  /** Stays that were nobody's plan — the more valuable half (§6.4). */
  unplanned: ReviewUnplanned[];
  totals: ReviewTotals;
  /**
   * What this screen cannot do yet, so it can say so rather than let
   * somebody look for it: the recap is built from photo clusters and
   * has no idea this trip was planned (§8.7).
   */
  omits: string[];
}

export const tripReview = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/review", auth: true },
  async ({ planId }: { planId: number }): Promise<TripReviewResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const visits = (await listVisits(planId, plan.ownerId)) ?? [];
    const confirmed = visits.filter((visit) => visit.confirmed && !visit.dismissed);
    const visitedRefs = new Set(
      confirmed.map((visit) => visit.osmRef).filter((ref): ref is string => ref !== null),
    );
    const visitedStopIds = new Set(
      confirmed.map((visit) => visit.stopId).filter((id): id is number => id !== null),
    );

    const { startsOn, endsOn } = span(plan.legs);
    const stops = collectStops(plan.legs);
    const photoCounts = await photosByRef(
      userId,
      [...new Set([...stops.map((stop) => stop.osmRef), ...visitedRefs])],
      startsOn,
      endsOn,
    );

    const reviewStops: ReviewStop[] = stops.map((stop) => ({
      legIndex: stop.legIndex,
      dayIndex: stop.dayIndex,
      date: stop.date,
      osmRef: stop.osmRef,
      name: stop.name,
      status: stop.status,
      visited: visitedStopIds.has(stop.rowId) || visitedRefs.has(stop.osmRef),
      photos: photoCounts.get(stop.osmRef) ?? 0,
    }));

    const plannedRefs = new Set(stops.map((stop) => stop.osmRef));
    const plannedStopIds = new Set(stops.map((stop) => stop.rowId));
    const unplanned: ReviewUnplanned[] = confirmed
      .filter((visit) => !isPlanned(visit, plannedRefs, plannedStopIds))
      .map((visit) => ({
        name: visit.name,
        osmRef: visit.osmRef,
        lat: visit.lat,
        lon: visit.lon,
        arrivedAt: visit.arrivedAt,
        photos: visit.osmRef === null ? 0 : photoCounts.get(visit.osmRef) ?? 0,
      }));

    return {
      startsOn,
      endsOn,
      stops: reviewStops,
      unplanned,
      totals: {
        planned: reviewStops.length,
        done: reviewStops.filter((stop) => stop.status === "done").length,
        skipped: reviewStops.filter((stop) => stop.status === "skipped").length,
        untouched: reviewStops.filter(
          (stop) => stop.status === "planned" && !stop.visited,
        ).length,
        unplanned: unplanned.length,
        photos: reviewStops.reduce((sum, stop) => sum + stop.photos, 0)
          + unplanned.reduce((sum, stay) => sum + stay.photos, 0),
      },
      omits: ["recap"],
    };
  },
);

function isPlanned(
  visit: StoredVisit,
  plannedRefs: ReadonlySet<string>,
  plannedStopIds: ReadonlySet<number>,
): boolean {
  if (visit.stopId !== null && plannedStopIds.has(visit.stopId)) return true;
  return visit.osmRef !== null && plannedRefs.has(visit.osmRef);
}

interface FlatStop {
  legIndex: number;
  dayIndex: number;
  date: string | null;
  rowId: number;
  osmRef: string;
  name: string | null;
  status: string;
}

function collectStops(legs: StoredLeg[]): FlatStop[] {
  const out: FlatStop[] = [];
  for (const leg of legs) {
    for (const day of leg.days) {
      const date = leg.startDate === null ? null : addDays(leg.startDate, day.dayIndex);
      for (const block of day.blocks) {
        for (const stop of block.stops) {
          out.push({
            legIndex: leg.position,
            dayIndex: day.dayIndex,
            date,
            rowId: stop.rowId,
            osmRef: stop.osmRef,
            name: stop.name,
            status: stop.status,
          });
        }
      }
    }
  }
  return out;
}

/** First and last day of the trip, or nulls when it has no dates. */
function span(legs: StoredLeg[]): { startsOn: string | null; endsOn: string | null } {
  const days: string[] = [];
  for (const leg of legs) {
    if (leg.startDate === null) continue;
    for (const day of leg.days) days.push(addDays(leg.startDate, day.dayIndex));
  }
  if (days.length === 0) return { startsOn: null, endsOn: null };
  days.sort();
  return { startsOn: days[0], endsOn: days[days.length - 1] };
}

/**
 * How many photos this traveller took of each place, during the trip.
 *
 * Both restrictions matter. Somebody else's photograph of the same
 * church is not this person's memory of it, and a photograph from three
 * years ago is not a picture of this trip — without the date window the
 * count would quietly include every earlier visit.
 *
 * A trip without dates gets no counts at all rather than all-time ones.
 */
async function photosByRef(
  userId: number,
  refs: string[],
  startsOn: string | null,
  endsOn: string | null,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (refs.length === 0 || startsOn === null || endsOn === null) return counts;

  const rows = await db
    .select({
      osmRef: photoPoiMatches.osm_ref,
      count: sql<number>`count(*)::int`,
    })
    .from(photoPoiMatches)
    .innerJoin(photos, eq(photos.id, photoPoiMatches.photo_id))
    .where(
      and(
        inArray(photoPoiMatches.osm_ref, refs),
        eq(photos.user_id, userId),
        gte(photos.taken_at, `${startsOn} 00:00:00`),
        // The last day counts to its end, not to its midnight.
        lte(photos.taken_at, `${addDays(endsOn, 1)} 00:00:00`),
      ),
    )
    .groupBy(photoPoiMatches.osm_ref);

  for (const row of rows) counts.set(row.osmRef, row.count);
  return counts;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
