/**
 * What a day of a stay left behind (reise-planen-und-unterwegs.md,
 * stage 5): for each of its spots the weather of the visit and the
 * photos taken there, and the places the group stayed at without a
 * plan.
 *
 * Photos belong to a spot by place and day: the POI matcher tied them
 * to its OpenStreetMap reference, or they were taken within
 * `NEAR_M` of it on that day. Everybody sees only the photos they may
 * see anyway — their own and those of an album shared with them
 * (`accessiblePhotoCondition`). Taking part in a trip grants nothing.
 */

import { api, APIError } from "encore.dev/api";
import { and, asc, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { photoPoiMatches, photos } from "../db/schema";
import { accessiblePhotoCondition } from "../photo/photo-file-access";
import { requirePermission } from "../user/auth-handler";
import { addDays } from "./leg-dates";
import { loadPlan } from "./plan-store";
import { listVisits, type StoredVisit } from "./visit-store";
import type { VisitWeather } from "./visit-weather";

/** How close a photo has to be to count as one of the spot. */
export const NEAR_M = 100;
/** The first photos each spot names, for its card. */
export const FIRST_PHOTOS = 3;
/** Beyond this the count says "many" well enough. */
const MAX_COUNTED = 500;

export interface DiaryPhoto {
  id: number;
  filename: string;
}

export interface DiarySpot {
  osmRef: string;
  /** When the group got there, from the diary; null while not visited. */
  arrivedAt: string | null;
  weather: VisitWeather | null;
  photoCount: number;
  /** The first few, oldest first, for the card. */
  photos: DiaryPhoto[];
}

export interface DiaryStay {
  visitId: number;
  name: string | null;
  osmRef: string | null;
  lat: number;
  lon: number;
  arrivedAt: string;
  leftAt: string | null;
  weather: VisitWeather | null;
  photoCount: number;
  photos: DiaryPhoto[];
}

export interface DayDiaryRequest {
  planId: number;
  legIndex: number;
  dayIndex: number;
}

export interface DayDiaryResponse {
  /** The day's date; null for a trip without one (then nothing is known). */
  date: string | null;
  spots: DiarySpot[];
  /** Where the group stayed long enough without a plan, in order. */
  unplanned: DiaryStay[];
}

export const tripDayDiary = api(
  {
    expose: true,
    method: "GET",
    path: "/trip-planner/plans/:planId/legs/:legIndex/days/:dayIndex/diary",
    auth: true,
  },
  async (req: DayDiaryRequest): Promise<DayDiaryResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = plan.legs.find((l) => l.position === req.legIndex);
    if (!leg) throw APIError.notFound(`leg ${req.legIndex} not found in this plan`);
    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in this leg`);

    const date = leg.startDate ? addDays(leg.startDate, day.dayIndex) : null;
    const stops = day.blocks.flatMap((b) => b.stops);
    if (!date) {
      return {
        date: null,
        spots: stops.map((s) => ({ osmRef: s.osmRef, arrivedAt: null, weather: null, photoCount: 0, photos: [] })),
        unplanned: [],
      };
    }

    const visits = ((await listVisits(plan.id, plan.ownerId)) ?? [])
      .filter((v) => v.confirmed && !v.dismissed);
    const byStop = new Map<number, StoredVisit>();
    for (const v of visits) if (v.stopId !== null && !byStop.has(v.stopId)) byStop.set(v.stopId, v);
    const stopIds = new Set(stops.map((s) => s.rowId));

    const spots: DiarySpot[] = [];
    for (const stop of stops) {
      const visit = byStop.get(stop.rowId) ?? null;
      const found = await photosAt(userId, date, { lat: stop.lat, lon: stop.lon }, stop.osmRef);
      spots.push({
        osmRef: stop.osmRef,
        arrivedAt: visit?.arrivedAt ?? null,
        weather: visit?.weather ?? null,
        photoCount: found.length,
        photos: found.slice(0, FIRST_PHOTOS),
      });
    }

    // An unplanned stay of this day: no stop of the plan, and it began
    // on this date. The instant is compared by its UTC date, which is
    // the trip's own date for every place this side of the date line
    // during the day; good enough for a diary line.
    const unplanned: DiaryStay[] = [];
    for (const v of visits) {
      if (v.stopId !== null && stopIds.has(v.stopId)) continue;
      if (v.stopId !== null) continue;
      if (v.arrivedAt.slice(0, 10) !== date) continue;
      const found = await photosAt(userId, date, { lat: v.lat, lon: v.lon }, v.osmRef);
      unplanned.push({
        visitId: v.id,
        name: v.name,
        osmRef: v.osmRef,
        lat: v.lat,
        lon: v.lon,
        arrivedAt: v.arrivedAt,
        leftAt: v.leftAt,
        weather: v.weather,
        photoCount: found.length,
        photos: found.slice(0, FIRST_PHOTOS),
      });
    }
    return { date, spots, unplanned };
  },
);

/**
 * The photos `userId` may see that were taken at a place on
 * a date, oldest first: matched to its OpenStreetMap reference, or
 * within `NEAR_M` of it.
 */
export async function photosAt(
  userId: number,
  date: string,
  at: { lat: number; lon: number },
  osmRef: string | null,
): Promise<DiaryPhoto[]> {
  const dLat = NEAR_M / 111_000;
  const dLon = NEAR_M / (111_000 * Math.max(0.01, Math.cos((at.lat * Math.PI) / 180)));
  const near = sql`(${photos.latitude} BETWEEN ${at.lat - dLat} AND ${at.lat + dLat}
    AND ${photos.longitude} BETWEEN ${at.lon - dLon} AND ${at.lon + dLon})`;
  const place: SQL = osmRef
    ? or(
        sql`EXISTS (SELECT 1 FROM ${photoPoiMatches} m WHERE m.photo_id = ${photos.id} AND m.osm_ref = ${osmRef})`,
        near,
      )!
    : near;
  const rows = await db
    .select({ id: photos.id, filename: photos.filename })
    .from(photos)
    .where(and(
      accessiblePhotoCondition(userId),
      // Taken on that day by the camera's own clock, as the review reads it.
      gte(photos.taken_at, `${date} 00:00:00`),
      lt(photos.taken_at, `${addDays(date, 1)} 00:00:00`),
      place,
    ))
    .orderBy(asc(photos.taken_at), asc(photos.id))
    .limit(MAX_COUNTED);
  return rows;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
