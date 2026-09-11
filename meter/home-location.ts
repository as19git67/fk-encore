/**
 * Home location + degree-day fetch endpoints (#1023 follow-up).
 *
 *   GET    /meters/home-location           (meters.view)
 *   PUT    /meters/home-location           (meters.manage)  { label, lat, lon, source? }
 *   DELETE /meters/home-location           (meters.manage)
 *   GET    /meters/places?q=               (meters.manage)  place search for the picker
 *   POST   /meters/degree-days/fetch       (meters.manage)  fill missing months now
 *   POST   /internal/meters/degree-days    job entry point (not exposed)
 */

import { api, APIError } from "encore.dev/api";
import type { Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { dailyAtUtc, schedule } from "../lib/local-cron";
import {
  deleteHomeLocation,
  fillDegreeDaysForUser,
  getHomeLocation,
  searchPlaces,
  setHomeLocation,
  userIdsWithHomeLocation,
  type DegreeDaysFillResult,
  type HomeLocation,
} from "./degree-days.service";
import { OpenMeteoUnavailableError, type GeocodeCandidate } from "./open-meteo-client";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

/** Third-party outages surface as `unavailable`, not as an internal error. */
function translate(err: unknown): never {
  if (err instanceof OpenMeteoUnavailableError) throw APIError.unavailable(err.message);
  throw err;
}

export const getMeterHomeLocation = api(
  { expose: true, method: "GET", path: "/meters/home-location", auth: true },
  async (): Promise<{ home: HomeLocation | null }> => {
    const userId = requireUser("meters.view");
    return { home: await getHomeLocation(userId) };
  },
);

interface SetHomeRequest {
  label: string;
  lat: number;
  lon: number;
  source?: string;
}

export const putMeterHomeLocation = api(
  { expose: true, method: "PUT", path: "/meters/home-location", auth: true },
  async ({ label, lat, lon, source }: SetHomeRequest): Promise<{ home: HomeLocation }> => {
    const userId = requireUser("meters.manage");
    const home = await setHomeLocation(userId, {
      label,
      lat,
      lon,
      source: source === "manual" ? "manual" : "geocoded",
    });
    return { home };
  },
);

export const deleteMeterHomeLocation = api(
  { expose: true, method: "DELETE", path: "/meters/home-location", auth: true },
  async (): Promise<{ deleted: boolean }> => {
    const userId = requireUser("meters.manage");
    await deleteHomeLocation(userId);
    return { deleted: true };
  },
);

export const searchMeterPlaces = api(
  { expose: true, method: "GET", path: "/meters/places", auth: true },
  async ({ q }: { q: Query<string> }): Promise<{ places: GeocodeCandidate[] }> => {
    requireUser("meters.manage");
    try {
      return { places: await searchPlaces(q ?? "") };
    } catch (err) {
      translate(err);
    }
  },
);

export const fetchDegreeDays = api(
  { expose: true, method: "POST", path: "/meters/degree-days/fetch", auth: true },
  async (): Promise<DegreeDaysFillResult> => {
    const userId = requireUser("meters.manage");
    try {
      return await fillDegreeDaysForUser(userId);
    } catch (err) {
      translate(err);
    }
  },
);

export interface DegreeDaysJobResult {
  users: number;
  monthsWritten: number;
  failures: number;
}

export const runDegreeDaysJob = api(
  { expose: false, method: "POST", path: "/internal/meters/degree-days" },
  async (): Promise<DegreeDaysJobResult> => {
    const result: DegreeDaysJobResult = { users: 0, monthsWritten: 0, failures: 0 };
    for (const userId of await userIdsWithHomeLocation()) {
      result.users += 1;
      try {
        const fill = await fillDegreeDaysForUser(userId);
        result.monthsWritten += fill.monthsWritten;
      } catch (err) {
        result.failures += 1;
        console.warn(`[meter.degree-days] user ${userId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(
      `[meter.degree-days] done: users=${result.users} written=${result.monthsWritten} failures=${result.failures}`,
    );
    return result;
  },
);

// Daily is cheap — the fill is a no-op until a new month has landed in the
// archive — and it means a fresh month shows up in the report within a day
// of becoming available, without anybody having to remember to import it.
schedule({
  name: "meter-degree-days",
  description: "Fetch heating degree days from the Open-Meteo archive for households with a home location",
  service: "meter",
  scheduleLabel: "daily 04:00 UTC",
  nextFire: dailyAtUtc(4, 0),
  run: () => runDegreeDaysJob(),
});
