/**
 * The whole plan in one payload, for the phone to keep (§3.9).
 *
 * "Ein fertiger Plan lässt sich komplett aufs iPhone laden und
 * funktioniert im Ausland ohne Datenverbindung." The reason that
 * sentence is cheap to keep is the coarse resolution (§4.1): a plan
 * made of blocks, labels and durations has nothing in it that needs a
 * live connection to stay true. There are no minute-precise times to
 * go stale, because there never were any.
 *
 * So this is one request rather than the dozen the day screen makes
 * online — plan, legs, days, blocks, stops, the pool, and the light of
 * every dated day. One request, because a bundle assembled from twelve
 * calls is a bundle that can be half-downloaded, and a half-downloaded
 * plan is the failure this endpoint exists to prevent.
 *
 * **Two things are deliberately not in it.**
 *
 * The weather (§7.2). A forecast is the one part of the plan that is
 * worthless when stale: a three-day-old "trocken" read on the morning
 * it is pouring is worse than no forecast at all, and the screen
 * already distinguishes "keine Vorhersage" from "trocken". Offline the
 * day simply says nothing about the sky.
 *
 * Map tiles (§14). Vector tiles out of the PBFs are their own large
 * piece of work; offline there is the block list, the spots and the
 * directions, and no map. Saying so plainly is better than a bundle
 * that silently leaves a grey rectangle where the map was.
 *
 * The light, by contrast, belongs in it: it is arithmetic on rows the
 * plan already carries (`daylight.ts`), it does not age, and computing
 * it here rather than on the phone keeps one implementation of it.
 */

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { lightOfDay, validateOffset, type DayLightResponse } from "./daylight";
import { loadPlan, type StoredPlan } from "./plan-store";

export interface OfflineBundleRequest {
  planId: number;
  /**
   * The destination's offset from UTC in minutes — the same argument
   * the light endpoint takes, and for the same reason: a coordinate
   * does not carry its time zone.
   */
  utcOffsetMinutes?: Query<number>;
}

export interface BundledDayLight {
  legIndex: number;
  dayIndex: number;
  /** The date this light is for. Never null — undated days are left out. */
  date: string;
  light: DayLightResponse;
}

export interface OfflineBundleResponse {
  /**
   * When this bundle was assembled. The phone shows it as the age of
   * what it is displaying; a plan without a date on it is a plan
   * nobody can judge.
   */
  generatedAt: string;
  plan: StoredPlan;
  /** The light of every dated day that has stops, best window first. */
  light: BundledDayLight[];
  /**
   * What the bundle knowingly leaves out, so the app can say it rather
   * than let somebody discover it in a foreign city (§14).
   */
  omits: string[];
}

export const offlineBundle = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/bundle", auth: true },
  async (req: OfflineBundleRequest): Promise<OfflineBundleResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const offset = validateOffset(req.utcOffsetMinutes);
    const light: BundledDayLight[] = [];
    for (const leg of plan.legs) {
      if (leg.startDate === null) continue;
      for (const day of leg.days) {
        // A day at trip resolution (§4.3) has a frame and no stops.
        // Its light would be four windows over the anchor and nothing
        // to apply them to — weight without a reader.
        if (!day.detailed) continue;
        const computed = lightOfDay(leg, day, offset);
        if (computed.day === null) continue;
        light.push({
          legIndex: leg.position,
          dayIndex: day.dayIndex,
          date: computed.day,
          light: computed,
        });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      plan,
      light,
      omits: ["weather", "map"],
    };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
