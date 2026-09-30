/**
 * The router, seen from the app and the admin (§24, stage 1).
 *
 * Two endpoints, both read-only. `status` says whether the router is
 * there, whether it has tiles and how old they are next to the newest
 * region — the sentence the region admin shows instead of a stale
 * answer passed off as current (§15.3). `compare` puts the estimate
 * next to the router for one pair: the measurement §14 asks for
 * before the router is allowed to shape the plan (stage 2).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { desc, inArray } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { getRouterClient, type RouterStatus } from "./router-client";
import { travelLeg, type TransportMode, type TravelLeg } from "./travel";

export interface RoutingStatusResponse extends RouterStatus {
  /** The newest ready region's import time (ISO), or null without one. */
  newestRegionAt: string | null;
  /**
   * A region imported after the tiles were built: it is searchable for
   * spots but not yet routable, until the routing container restarts.
   */
  tilesBehindRegion: boolean;
}

export const routingStatus = api(
  { expose: true, method: "GET", path: "/trip-planner/routing/status", auth: true },
  async (): Promise<RoutingStatusResponse> => {
    requireUser();
    const [status, newest] = await Promise.all([
      getRouterClient().status(),
      db
        .select({ importedAt: osmRegionImports.imported_at })
        .from(osmRegionImports)
        .where(inArray(osmRegionImports.status, ["ready_running", "ready_stopped"]))
        .orderBy(desc(osmRegionImports.imported_at))
        .limit(1),
    ]);
    const newestRegionAt = newest[0]?.importedAt ?? null;
    return {
      ...status,
      newestRegionAt,
      tilesBehindRegion: tilesBehind(status.tilesBuiltAt, newestRegionAt),
    };
  },
);

/** Tiles built before the newest region came: that region is not in them. */
export function tilesBehind(tilesBuiltAt: string | null, newestRegionAt: string | null): boolean {
  if (!tilesBuiltAt || !newestRegionAt) return false;
  return new Date(tilesBuiltAt).getTime() < new Date(newestRegionAt).getTime();
}

export interface CompareRequest {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  mode?: TransportMode;
}

export interface CompareResponse {
  mode: TransportMode;
  estimate: TravelLeg;
  /** Null when the router is away or does not know this mode. */
  router: { minutes: number; distanceM: number } | null;
  /** Router minus estimate, in minutes; positive when the estimate is optimistic. */
  differenceMinutes: number | null;
}

export const compareTravel = api(
  { expose: true, method: "POST", path: "/trip-planner/routing/compare", auth: true },
  async (req: CompareRequest): Promise<CompareResponse> => {
    requireUser();
    const mode = req.mode ?? "car";
    if (!["foot", "bike", "transit", "car"].includes(mode)) {
      throw APIError.invalidArgument(`unknown mode '${mode}'`);
    }
    for (const [label, p] of [["from", req.from], ["to", req.to]] as const) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)
          || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
        throw APIError.invalidArgument(`${label} is not a coordinate`);
      }
    }
    const estimate = travelLeg(req.from, req.to, mode);
    const routed = await getRouterClient().route(req.from, req.to, mode);
    return {
      mode,
      estimate,
      router: routed ? { minutes: routed.minutes, distanceM: routed.distanceM } : null,
      differenceMinutes: routed ? routed.minutes - estimate.minutes : null,
    };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
