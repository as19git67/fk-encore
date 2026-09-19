/**
 * Finding a signposted way, and taking one into a trip (§4.7).
 *
 * Until now a route reached a plan only by hand: somebody typed a name,
 * picked two ends off the device's place search and estimated how long
 * it takes. That is the right fallback and stays — but OpenStreetMap
 * already holds the Ponale, the Sentiero della Pace and every other
 * signposted way as a relation, with its shape, its length and often
 * its climb. Since the import carries them (`geo/src/osm2pgsql.lua`),
 * the planner can offer them.
 *
 * Two endpoints, and the split matters:
 *
 *   - **Looking** is stateless. It asks geo what runs near the city and
 *     ranks nothing: which way is worth a day is the travellers'
 *     business, and a list ordered by how close it passes is the one
 *     claim the data actually supports.
 *   - **Taking one** writes a pool entry, through the same
 *     `POST …/finds` machinery every other find goes through (§9.2).
 *     A route from the map is a find like any other; what it brings
 *     along is its ends, its length, its climb and its shape.
 *
 * A region imported before routes existed has no such data. That is
 * said plainly — `imported: false` — rather than answered with an empty
 * list, because "nothing here" and "nobody has imported this yet" are
 * different answers and only one of them is the traveller's problem
 * (§15.3).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient, type GeoRoute } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { addFind } from "./add-find";
import { groupPaceFactor, type GroupProfile } from "./blocks";
import { MAX_VIA_POINTS } from "./extent";
import { loadPlan } from "./plan-store";
import { routeMinutes } from "./route-duration";
import type { TransportMode } from "./travel";

/** How far around a city to look, when nobody says. */
const DEFAULT_RADIUS_M = 15_000;
const MAX_RADIUS_M = 50_000;
const DEFAULT_LIMIT = 40;

export interface NearbyRoutesRequest {
  planId: number;
  /** Which city of the trip. Defaults to the first. */
  legIndex?: number;
  /** hiking | foot | bicycle | mtb. Omitted = all four. */
  kinds?: string[];
  radiusM?: number;
}

export interface NearbyRoute {
  osmRef: string;
  name: string;
  /** hiking | foot | bicycle | mtb. */
  route: string;
  network: string | null;
  ref: string | null;
  lengthM: number;
  ascentM: number | null;
  /** How close the way passes to the city, in metres. */
  distanceM: number;
  /**
   * What it would take, at the leg's pace (`route-duration.ts`). A
   * starting number: whoever takes it in may change it.
   */
  estimatedMinutes: number;
  /** True when it finishes where it began. */
  roundtrip: boolean;
  /**
   * False when the relation's members do not join into one way. It can
   * still be taken in — it just arrives without an end, and the day
   * carries on from where it started.
   */
  joined: boolean;
  website: string | null;
  difficulty: string | null;
  /** True when this trip already holds it. */
  inPool: boolean;
}

export interface NearbyRoutesResponse {
  legIndex: number;
  /** The region database searched, or null when none covers the city. */
  region: string | null;
  /**
   * False when the region predates the route import. The list is empty
   * because nothing was imported, not because nothing is there.
   */
  imported: boolean;
  routes: NearbyRoute[];
  hasMore: boolean;
  /** Why the list is empty, in the traveller's words, or null. */
  note: string | null;
  /**
   * How many ways were left out because somebody on this trip is on
   * wheels (§3.5). Said rather than silently subtracted: a list that
   * quietly got shorter looks like a region with nothing in it.
   */
  omittedForWheels: number;
}

export const nearbyRoutes = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/routes", auth: true },
  async (req: NearbyRoutesRequest): Promise<NearbyRoutesResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    const radiusM = validateRadius(req.radiusM);
    const region = await pickRegion(leg.anchor.lat, leg.anchor.lon);
    if (!region) {
      return {
        legIndex,
        region: null,
        imported: false,
        routes: [],
        hasMore: false,
        note: "Für diese Stadt ist noch keine Region importiert.",
      };
    }

    let page;
    try {
      page = await getGeoClient().searchRoutes(region.postgresDb, {
        center: { lat: leg.anchor.lat, lon: leg.anchor.lon },
        radiusM,
        kinds: req.kinds,
        limit: DEFAULT_LIMIT,
      });
    } catch {
      throw APIError.unavailable("die Region antwortet gerade nicht");
    }

    const inPool = new Set(leg.pool.map((c) => c.osmRef));
    for (const day of leg.days) {
      for (const block of day.blocks) {
        for (const stop of block.stops) inPool.add(stop.osmRef);
      }
    }

    // Who is coming decides two things here, and only one of them is a
    // number (§3.5). The pace stretches every estimate; being on
    // wheels takes whole ways off the list, because a path that climbs
    // is not a slower day out for a wheelchair, it is not a day out.
    const group = (plan.constraints.group ?? undefined) as GroupProfile | undefined;
    const pace = groupPaceFactor(group);
    const offered = group?.onWheels
      ? page.routes.filter((route) => rollable(route))
      : page.routes;
    const omittedForWheels = page.routes.length - offered.length;

    return {
      legIndex,
      region: region.postgresDb,
      imported: page.imported,
      routes: offered.map((route) => toNearby(route, leg.mode, inPool, pace)),
      hasMore: page.hasMore,
      note: noteFor(page.imported, offered.length, omittedForWheels),
      omittedForWheels,
    };
  },
);

export interface TakeRouteRequest {
  planId: number;
  /** As the search answered it: "relation:123". */
  osmRef: string;
  legIndex?: number;
  /** Override the estimate. Minutes. */
  dwellMinutes?: number;
  /** Why it is worth it, in the traveller's words. */
  note?: string;
}

export interface TakeRouteResponse {
  osmRef: string;
  name: string;
  legIndex: number;
  /** What the pool entry ended up with. */
  dwellMinutes: number;
  /** True when the route arrived without an end — a loop, or unjoined. */
  roundtrip: boolean;
}

export const takeRoute = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/routes", auth: true },
  async (req: TakeRouteRequest): Promise<TakeRouteResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    const region = await pickRegion(leg.anchor.lat, leg.anchor.lon);
    if (!region) {
      throw APIError.failedPrecondition("für diese Stadt ist noch keine Region importiert");
    }

    // Looked up again rather than trusted from the client: the ends and
    // the shape decide how the day is walked, and a request is not
    // where those should come from.
    let page;
    try {
      page = await getGeoClient().searchRoutes(region.postgresDb, {
        center: { lat: leg.anchor.lat, lon: leg.anchor.lon },
        radiusM: MAX_RADIUS_M,
        limit: 500,
      });
    } catch {
      throw APIError.unavailable("die Region antwortet gerade nicht");
    }

    const route = page.routes.find((r) => r.osmRef === req.osmRef);
    if (!route) {
      throw APIError.notFound(
        page.imported
          ? "diese Strecke liegt nicht in der Nähe dieser Stadt"
          : "für diese Region sind noch keine Strecken importiert",
      );
    }

    const dwellMinutes = req.dwellMinutes ?? estimateFor(route, leg.mode);
    // Where the day carries on from once the way is done.
    //
    //   - A way with two ends finishes at the far one.
    //   - A loop finishes where it began, so that *is* its end — which
    //     keeps its length and its shape, both of which a bare point
    //     would throw away.
    //   - A relation whose members do not join up has no way we can
    //     state. It comes in as a place with a name and a duration and
    //     nothing claimed about its course (§15.3).
    const end = route.end ?? (route.joined ? route.start : null);
    await addFind({
      planId: req.planId,
      legIndex,
      osmRef: route.osmRef,
      lat: route.start.lat,
      lon: route.start.lon,
      name: route.name,
      note: req.note,
      sourceUrl: route.website ?? undefined,
      dwellMinutes,
      end: end ?? undefined,
      lengthM: end ? route.lengthM : undefined,
      ascentM: end ? route.ascentM ?? undefined : undefined,
      via: end ? route.via.slice(0, MAX_VIA_POINTS) : undefined,
    });

    return {
      osmRef: route.osmRef,
      name: route.name,
      legIndex,
      dwellMinutes,
      roundtrip: route.roundtrip,
    };
  },
);

function toNearby(
  route: GeoRoute,
  mode: TransportMode,
  inPool: ReadonlySet<string>,
  paceFactor: number,
): NearbyRoute {
  return {
    osmRef: route.osmRef,
    name: route.name,
    route: route.route,
    network: route.network,
    ref: route.ref,
    lengthM: route.lengthM,
    ascentM: route.ascentM,
    distanceM: route.distanceM,
    estimatedMinutes: estimateFor(route, mode, paceFactor),
    roundtrip: route.roundtrip,
    joined: route.joined,
    website: route.website,
    difficulty: route.difficulty,
    inPool: inPool.has(route.osmRef),
  };
}

/**
 * How long this way takes the people on this leg.
 *
 * A cycling route is ridden whatever the leg does — you do not walk the
 * Gardesana on a leg that happens to be on foot — and a walking route
 * is walked even on a leg that gets about by car.
 */
function estimateFor(route: GeoRoute, mode: TransportMode, paceFactor = 1): number {
  const byRoute: TransportMode | null = route.route === "bicycle" || route.route === "mtb"
    ? "bike"
    : route.route === "hiking" || route.route === "foot"
      ? "foot"
      : null;
  return routeMinutes(route.lengthM, route.ascentM, byRoute ?? mode, paceFactor);
}

function noteFor(imported: boolean, found: number, omittedForWheels: number): string | null {
  if (!imported) {
    return "Diese Region wurde importiert, bevor der Planer Strecken kannte — "
      + "ein neuer Import bringt sie mit.";
  }
  // Said whichever way it turned out: a list that quietly got shorter
  // reads as a region with nothing in it, and an empty one after
  // filtering reads as a region with nothing in it *for us*, which is
  // a different sentence (§15.3).
  if (found === 0 && omittedForWheels > 0) {
    return `In der Nähe sind nur Strecken mit Anstieg erfasst (${omittedForWheels}) — `
      + "die schlägt der Planer nicht vor, weil jemand mit Rollstuhl, Rollator oder "
      + "Kinderwagen mitfährt.";
  }
  if (found === 0) return "In der Nähe ist keine ausgeschilderte Strecke erfasst.";
  if (omittedForWheels > 0) {
    return `${omittedForWheels} Strecke${omittedForWheels === 1 ? "" : "n"} mit Anstieg `
      + "ist nicht dabei — jemand fährt mit Rollstuhl, Rollator oder Kinderwagen mit.";
  }
  return null;
}

/**
 * Is this a way somebody on wheels could actually take?
 *
 * Two things rule one out, and both are the map's own words rather
 * than a judgement about a person:
 *
 *   - **It climbs.** Where the relation says how much, any climb at
 *     all is enough: pushing a wheelchair up a hundred metres of
 *     ascent is not a gentler version of the same outing.
 *   - **It is a path.** `hiking` and `mtb` are waymarked over ground
 *     chosen for boots and tyres. `foot` and `bicycle` routes are
 *     ordinarily made ways, so they stay — with the honest limit that
 *     OpenStreetMap does not promise a surface, and the app says the
 *     list was filtered rather than pretending it is a guarantee.
 */
function rollable(route: GeoRoute): boolean {
  if (route.route === "hiking" || route.route === "mtb") return false;
  return (route.ascentM ?? 0) <= 0;
}

function validateRadius(radiusM: number | undefined): number {
  if (radiusM === undefined) return DEFAULT_RADIUS_M;
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw APIError.invalidArgument("radiusM must be a positive number");
  }
  return Math.min(Math.round(radiusM), MAX_RADIUS_M);
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
