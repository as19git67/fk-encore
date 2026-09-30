/**
 * Where the trip sets off from and returns to (§22.7).
 *
 * A journey needs two ends, and until now the trip knew only its
 * places: the way to the first one and the way home had nowhere to
 * start or finish. With a home, "Anreise" and "Heimreise" are journeys
 * like the one between two places, with the same corridor along them.
 *
 * The frame is the organiser's (§6.2). Setting or clearing the home
 * re-plans nothing by itself; a journey that already leads there keeps
 * its far end until it is changed.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { requireOrganiser } from "./plan-access";
import { loadPlan, loadUserHome, setPlanHome, setUserHome, type PlanHome } from "./plan-store";
import type { PlanResponse } from "./plans";

export interface SetHomeRequest {
  planId: number;
  lat?: number;
  lon?: number;
  /** What it is called: "Zuhause", the street, the town. */
  label?: string;
  /** True to forget the home again. */
  clear?: boolean;
}

export const setTripHome = api(
  { expose: true, method: "PATCH", path: "/trip-planner/plans/:planId/home", auth: true },
  async (req: SetHomeRequest): Promise<PlanResponse> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "photos.view");
    const userId = parseInt(auth.userID, 10);
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    await requireOrganiser(req.planId, userId, "Zuhause ändern");

    if (req.clear) {
      await setPlanHome(plan.id, null);
    } else {
      const { lat, lon } = req;
      const home = validHome(lat, lon, req.label);
      await setPlanHome(plan.id, home);
      // The first home anybody gives a trip is, until they say
      // otherwise, where they live: the next trip starts with it.
      if (!(await loadUserHome(userId))) await setUserHome(userId, home);
    }

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while it was being written");
    return { plan: updated };
  },
);

function validHome(lat: unknown, lon: unknown, label: string | undefined): PlanHome {
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument(`lat out of range: ${lat}`);
  }
  if (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument(`lon out of range: ${lon}`);
  }
  return { lat, lon, label: label?.trim() || null };
}

export interface UserHomeResponse {
  /** Where this person lives, or null while nobody said. */
  home: PlanHome | null;
}

/**
 * Where the person lives (§22.7) — said once, in the settings, and
 * copied into every trip they create from then on. A trip keeps its
 * own copy, so changing this moves no trip that already exists.
 */
export const getUserHome = api(
  { expose: true, method: "GET", path: "/trip-planner/home", auth: true },
  async (): Promise<UserHomeResponse> => {
    return { home: await loadUserHome(requireUser()) };
  },
);

export interface SetUserHomeRequest {
  lat?: number;
  lon?: number;
  label?: string;
  /** True to forget it again. */
  clear?: boolean;
}

export const setUserHomeEndpoint = api(
  { expose: true, method: "PATCH", path: "/trip-planner/home", auth: true },
  async (req: SetUserHomeRequest): Promise<UserHomeResponse> => {
    const userId = requireUser();
    await setUserHome(userId, req.clear ? null : validHome(req.lat, req.lon, req.label));
    return { home: await loadUserHome(userId) };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
