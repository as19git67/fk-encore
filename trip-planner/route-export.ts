/**
 * Handing a route over to a navigation app (§4.7).
 *
 * The planner decides *which* way is worth a day; it does not walk it
 * with you. Komoot, Organic Maps, Outdooractive and a Garmin do that,
 * and all of them read GPX. This is where a way leaves the plan for
 * one of them.
 *
 * ## Why this does not reuse the search's shape
 *
 * `routes.ts` carries a `via` of at most sixty-four points, simplified
 * to fifty metres. That shape exists to be drawn on a map and taken
 * offline, and for that it is right. As a file somebody follows it is
 * wrong: sixty-four points across twenty kilometres cut every
 * switchback off a mountain path, and the track that comes out is not
 * the way that is signposted. Following it would mean leaving the
 * path.
 *
 * So the geometry is fetched fresh, unsimplified, through
 * `geo.routeGeometry` — a separate call for exactly this reason.
 *
 * ## A raw endpoint, because the answer is a file
 *
 * The rest of the trip planner answers in JSON. This answers with
 * `application/gpx+xml` and a `Content-Disposition`, so the browser
 * saves it and iOS hands it straight to the share sheet. A JSON field
 * holding the XML would work and would make every client unwrap it
 * before it could do anything with it.
 *
 * The route is looked up **through the plan**: a plan the caller may
 * see, a leg it has, a region that covers it. Nobody gets to name a
 * region database and a relation id and have the service read it out.
 */

import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import log from "encore.dev/log";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient, type GeoClient } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { loadPlan } from "./plan-store";
import { buildGpx, EmptyTrackError, gpxFilename } from "./gpx";

export interface RouteGpxRequest {
  planId: number;
  osmRef: string;
  legIndex?: number;
}

export type RouteGpxResult =
  | { ok: true; filename: string; gpx: string }
  | { ok: false; status: number; message: string };

export interface RouteGpxDeps {
  geo?: GeoClient;
  now?: () => Date;
}

/**
 * The relation id in an `osmRef`, or null when it is not one.
 *
 * Only relations: a signposted way is a relation, and a `node:` or
 * `way:` ref reaching here means somebody is exporting the wrong kind
 * of thing.
 */
export function relationId(osmRef: string): number | null {
  const match = /^relation:(\d+)$/.exec(osmRef.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The GPX for one route of one plan, or why there is none.
 *
 * A result rather than a thrown error, so the raw handler can turn it
 * into a status code and this can be tested without one. Every "no" a
 * traveller can actually hit has a sentence of its own: a plan that is
 * not theirs, a leg that is not there, a region nobody imported, a
 * relation that a re-import dropped, and a relation with no usable
 * course (§15.3).
 */
export async function routeGpx(
  userId: number,
  req: RouteGpxRequest,
  deps: RouteGpxDeps = {},
): Promise<RouteGpxResult> {
  const geo = deps.geo ?? getGeoClient();

  const osmId = relationId(req.osmRef);
  if (osmId === null) {
    return { ok: false, status: 400, message: `kein Streckenverweis: ${req.osmRef}` };
  }

  const plan = await loadPlan(req.planId, userId);
  if (!plan) return { ok: false, status: 404, message: "plan not found" };

  const legIndex = req.legIndex ?? 0;
  const leg = plan.legs.find((l) => l.position === legIndex);
  if (!leg) return { ok: false, status: 404, message: `leg ${legIndex} not found in this plan` };

  const region = await pickRegion(leg.anchor.lat, leg.anchor.lon);
  if (!region) {
    return {
      ok: false,
      status: 412,
      message: "für diese Stadt ist noch keine Region importiert",
    };
  }

  let geometry;
  try {
    geometry = await geo.routeGeometry(region.postgresDb, osmId);
  } catch (err) {
    log.error(err as Error, "route gpx: geo unreachable", { region: region.postgresDb });
    return { ok: false, status: 503, message: "die Region antwortet gerade nicht" };
  }

  if (!geometry) {
    // A link that outlived a re-import, or a relation a mapper
    // deleted. Both are ordinary and both deserve the same sentence.
    return {
      ok: false,
      status: 404,
      message: "diese Strecke ist in der Region nicht mehr vorhanden",
    };
  }

  try {
    const gpx = buildGpx({
      name: geometry.name,
      kind: geometry.route,
      parts: geometry.parts,
      lengthM: geometry.lengthM,
      ascentM: geometry.ascentM,
      osmRef: geometry.osmRef,
      network: geometry.network,
      ref: geometry.ref,
      website: geometry.website,
      time: deps.now?.(),
    });
    return { ok: true, filename: gpxFilename(geometry.name), gpx };
  } catch (err) {
    if (err instanceof EmptyTrackError) {
      return { ok: false, status: 422, message: err.message };
    }
    throw err;
  }
}

export const routeGpxDownload = api.raw(
  { expose: true, method: "GET", path: "/trip-planner/routes/gpx", auth: true },
  async (req, res) => {
    const auth = getAuthData();
    if (!auth) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
    try {
      requirePermission(auth, "photos.view");
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const planId = Number(params.get("planId"));
    if (!Number.isInteger(planId) || planId <= 0) {
      res.statusCode = 400;
      res.end("planId required");
      return;
    }
    const legParam = params.get("legIndex");
    const legIndex = legParam === null ? undefined : Number(legParam);
    if (legIndex !== undefined && !Number.isInteger(legIndex)) {
      res.statusCode = 400;
      res.end("legIndex must be a whole number");
      return;
    }

    const result = await routeGpx(parseInt(auth.userID, 10), {
      planId,
      osmRef: params.get("osmRef") ?? "",
      legIndex,
    });

    if (!result.ok) {
      res.statusCode = result.status;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(result.message);
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/gpx+xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.end(result.gpx);
  },
);
