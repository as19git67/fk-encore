/**
 * Signposted walking and cycling routes near a place (§4.7).
 *
 * The POI search answers "what is worth seeing around here" and hands
 * back points. This answers a different question — "what ways are there
 * to walk or ride here" — and a way is not a point: it starts in one
 * place, finishes in another, and the day carries on from its far end.
 *
 * Everything the planner needs is read out of the relation's geometry
 * at query time rather than frozen into columns at import:
 *
 *   - **The length** is the real length of the way, `ST_Length` over
 *     the whole geometry. The `distance` tag is a mapper's round
 *     number and is often missing; the geometry is neither.
 *   - **The two ends** come from `ST_LineMerge`. A relation whose
 *     members join up has an end; one that does not — gaps, branches,
 *     signposted alternates — has none that can be stated, and saying
 *     so is better than picking one of its loose ends (§15.3).
 *   - **The shape**, simplified, so the planner can tell what the route
 *     passes without a router and without the network (§4.7's corridor
 *     rule measures against this).
 *
 * A region imported before routes existed has no `osm_routes` table.
 * That is not an error, it is an older import: the page says so and the
 * caller can offer a re-import rather than showing an empty list that
 * looks like "there are no routes here".
 */

import { poolFor } from "./db.ts";
import {
  HIGHLIGHT_ALONG_M,
  HIGHLIGHT_KINDS,
  highlightsFrom,
  type KindCount,
  type RouteHighlight,
  routeWorth,
  UNNAMED_HIGHLIGHT_KINDS,
} from "./route-worth.ts";

export class RouteSearchError extends Error {}

/** The four `route=` values worth an outing, as the import filters them. */
export const ROUTE_KINDS = ["hiking", "foot", "bicycle", "mtb"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

export const DEFAULT_ROUTE_LIMIT = 50;
export const MAX_ROUTE_LIMIT = 200;
export const MAX_ROUTE_RADIUS_M = 50_000;

/**
 * How far apart two ends may be and still be the same place.
 *
 * A signposted loop rarely closes on the exact same node — it starts at
 * the car park and finishes at the bench beside it.
 */
export const ROUNDTRIP_TOLERANCE_M = 150;

/**
 * How coarse the shape handed to the planner may be.
 *
 * Half a thousandth of a degree is about fifty metres, well inside the
 * corridor the planner measures with, and it turns a relation of ten
 * thousand nodes into something a plan can carry offline.
 */
export const SIMPLIFY_TOLERANCE_DEG = 0.0005;

/** Vertices per piece when looking along a line for highlights. */
export const SUBDIVIDE_VERTICES = 32;

/** At most this many points in the shape, however long the way. */
export const MAX_VIA_POINTS = 64;

export interface RouteSearchOptions {
  center: { lat: number; lon: number };
  radiusM: number;
  /**
   * The near edge of a ring, in metres. Omitted or 0 searches a full
   * circle, which is what every caller did before rings existed.
   *
   * A ring rather than a bigger circle, because the answer is capped
   * and ordered by distance: raising `radiusM` alone hands back the
   * same near ways again and says there are more. Somebody who has
   * worked through what is close needs the near ones *gone*, not
   * outnumbered.
   */
  minRadiusM?: number;
  /** Omitted means all four kinds. */
  kinds?: readonly string[];
  limit?: number;
  /**
   * `distance` (the default, and all a caller from before §4.7's
   * ranking knows) or `worth`: the most rewarding first, by what the
   * way passes and how much it matters to its network (`route-worth.ts`).
   */
  order?: RouteOrder;
}

export const ROUTE_ORDERS = ["distance", "worth"] as const;
export type RouteOrder = (typeof ROUTE_ORDERS)[number];

/**
 * How many of the nearest ways are weighed when the order is `worth`.
 *
 * Ranking only the forty nearest would reorder the list somebody
 * already found dull. A pool five times the page lets a better way a
 * little further out climb past the near ones, while each candidate's
 * look along its line stays one indexed query.
 */
export const WORTH_POOL = 200;

export interface RoutePoint {
  lat: number;
  lon: number;
}

export interface RouteSearchResult {
  osmRef: string;
  id: number;
  name: string;
  /** hiking | foot | bicycle | mtb. */
  route: string;
  /** The walking or cycling network it belongs to, where tagged. */
  network: string | null;
  /** Its number on the signs, where it has one. */
  ref: string | null;
  /** The real length of the way, in metres. */
  lengthM: number;
  /** Metres of climb, where the relation says. Never guessed. */
  ascentM: number | null;
  /** How close the way passes to the search centre, in metres. */
  distanceM: number;
  start: RoutePoint;
  /**
   * Where it finishes — null for a loop, and for a relation whose
   * members do not join into one way.
   */
  end: RoutePoint | null;
  /** A simplified shape. Empty where the members do not join up. */
  via: RoutePoint[];
  /** True when the members join into one way, so the ends are readable. */
  joined: boolean;
  /** True when it finishes where it started. */
  roundtrip: boolean;
  website: string | null;
  wikipedia: string | null;
  wikidata: string | null;
  /** How hard it is, in whatever scale the relation uses. */
  difficulty: string | null;
  /**
   * What the way passes near the search centre: summits, viewpoints,
   * water, castles, somewhere to eat (`route-worth.ts`).
   *
   * Counted on the stretch inside the search's square only. A
   * thousand-kilometre cycle route passes everything; what matters to
   * somebody staying here is what it passes *here*.
   */
  highlights: RouteHighlight[];
  /** The sort key behind `order: "worth"`. Not meant to be shown. */
  worth: number;
}

export interface RouteSearchPage {
  routes: RouteSearchResult[];
  hasMore: boolean;
  /**
   * False when this region predates the route import. The list is then
   * empty because nothing was imported, not because nothing is there.
   */
  imported: boolean;
}

interface Row {
  osm_id: string;
  route: string;
  name: string;
  tags: Record<string, string> | null;
  length_m: number;
  distance_m: number;
  joined: boolean;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
  shape: string | null;
  highlights: KindCount[] | null;
}

export async function searchRoutes(
  database: string,
  opts: RouteSearchOptions,
): Promise<RouteSearchPage> {
  validatePoint(opts.center);
  const radiusM = validateRadius(opts.radiusM);
  const limit = clampLimit(opts.limit);
  const kinds = resolveKinds(opts.kinds);
  const minRadiusM = validateMinRadius(opts.minRadiusM, radiusM);

  const order = resolveOrder(opts.order);

  // Numbered as they are pushed, so a clause that is only sometimes
  // there cannot leave a gap: Postgres refuses a bind with more
  // parameters than the statement references.
  const params: unknown[] = [];
  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const lon = param(opts.center.lon);
  const lat = param(opts.center.lat);
  const centre = `ST_SetSRID(ST_Point(${lon}, ${lat}), 4326)::geography`;
  const far = param(radiusM);
  const kindList = param(kinds);
  const pool = param(order === "worth" ? Math.max(WORTH_POOL, limit) + 1 : limit + 1);
  // The near edge, as a negated containment rather than a distance
  // comparison: `NOT ST_DWithin` uses the same index as the far edge,
  // where `ST_Distance(...) > n` would scan. The same shape as the ring
  // in `day-targets.ts`.
  const nearEdge = minRadiusM > 0
    ? `\n         AND NOT ST_DWithin(geom::geography, ${centre}, ${param(minRadiusM)})`
    : "";

  // The square the highlights are counted in: the search's own reach,
  // in degrees, so the clip is a box operation and not a buffer.
  const box = searchBox(opts.center, radiusM);
  const boxDx = param(box.dLon);
  const boxDy = param(box.dLat);
  const highlightKinds = param(Object.keys(HIGHLIGHT_KINDS));
  const unnamedKinds = param(UNNAMED_HIGHLIGHT_KINDS);
  const along = param(HIGHLIGHT_ALONG_M);
  // An index-friendly pre-filter a little wider than `along` at any
  // latitude a region is imported for.
  const alongDeg = param(degreesFor(HIGHLIGHT_ALONG_M, opts.center.lat));

  const sql = `
    WITH near AS (
      SELECT osm_id, route, name, tags, geom,
             ST_Distance(geom::geography, ${centre}) AS distance_m
        FROM osm_routes
       WHERE ST_DWithin(geom::geography, ${centre}, ${far})
         AND route = ANY(${kindList}::text[])${nearEdge}
       ORDER BY distance_m, osm_id
       LIMIT ${pool}
    ), merged AS (
      SELECT near.*,
             ST_LineMerge(geom) AS line,
             ST_ClipByBox2D(
               geom,
               ST_Expand(ST_SetSRID(ST_Point(${lon}, ${lat}), 4326), ${boxDx}, ${boxDy})::box2d
             ) AS local
        FROM near
    )
    SELECT
      osm_id::text AS osm_id,
      route,
      name,
      tags,
      ST_Length(geom::geography) AS length_m,
      distance_m,
      GeometryType(line) = 'LINESTRING' AS joined,
      ST_Y(ST_StartPoint(ST_GeometryN(line, 1))) AS start_lat,
      ST_X(ST_StartPoint(ST_GeometryN(line, 1))) AS start_lon,
      CASE WHEN GeometryType(line) = 'LINESTRING'
           THEN ST_Y(ST_EndPoint(line)) END AS end_lat,
      CASE WHEN GeometryType(line) = 'LINESTRING'
           THEN ST_X(ST_EndPoint(line)) END AS end_lon,
      CASE WHEN GeometryType(line) = 'LINESTRING'
           THEN ST_AsGeoJSON(ST_SimplifyPreserveTopology(line, ${SIMPLIFY_TOLERANCE_DEG}))
           END AS shape,
      passed.highlights
      FROM merged
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('kind', kind, 'count', n, 'names', names))
                 AS highlights
          FROM (
            SELECT p.kind,
                   count(DISTINCT (p.osm_type, p.osm_id))::int AS n,
                   (array_agg(DISTINCT p.name) FILTER (WHERE p.name IS NOT NULL))[1:3]
                     AS names
              -- In short pieces, so each index lookup is a narrow box
              -- along the line rather than the whole square the line
              -- spans — in a city that square holds thousands of cafés
              -- the exact test would otherwise measure one by one.
              -- The DISTINCT above undoes a thing near two pieces.
              FROM ST_Subdivide(merged.local, ${SUBDIVIDE_VERTICES}) AS piece
              JOIN osm_pois p ON p.geom && ST_Expand(piece, ${alongDeg})
             WHERE p.kind = ANY(${highlightKinds}::text[])
               AND (p.name IS NOT NULL OR p.kind = ANY(${unnamedKinds}::text[]))
               AND ST_DWithin(p.geom::geography, piece::geography, ${along})
             GROUP BY p.kind
          ) kinds
      ) passed ON true
     ORDER BY distance_m, osm_id
  `;

  let rows: Row[];
  try {
    const res = await poolFor(database).query<Row>(sql, params);
    rows = res.rows;
  } catch (err) {
    // 42P01: the region was imported before routes were part of the
    // style. An older import, not a broken one.
    if ((err as { code?: string }).code === "42P01") {
      return { routes: [], hasMore: false, imported: false };
    }
    throw err;
  }

  const results = rows.map(toResult);
  if (order === "worth") {
    // Stable on distance: of two equally rewarding ways, the nearer.
    results.sort((a, b) => b.worth - a.worth || a.distanceM - b.distanceM);
  }
  const hasMore = results.length > limit;
  return {
    routes: results.slice(0, limit),
    hasMore,
    imported: true,
  };
}

function toResult(row: Row): RouteSearchResult {
  const tags = row.tags ?? {};
  const start: RoutePoint = { lat: row.start_lat ?? 0, lon: row.start_lon ?? 0 };
  const finish = row.end_lat !== null && row.end_lon !== null
    ? { lat: row.end_lat, lon: row.end_lon }
    : null;
  // A loop has no far end to carry the day on from; the plan wants to
  // hear "back where you started", which is an absent end (§4.7).
  const roundtrip = finish !== null
    ? metresBetween(start, finish) <= ROUNDTRIP_TOLERANCE_M
    : tags.roundtrip === "yes";

  const highlights = highlightsFrom(row.highlights);

  return {
    osmRef: `relation:${row.osm_id}`,
    id: Number(row.osm_id),
    name: row.name,
    route: row.route,
    network: tags.network ?? null,
    ref: tags.ref ?? null,
    lengthM: Math.round(row.length_m),
    ascentM: wholeMetres(tags.ascent),
    distanceM: Math.round(row.distance_m),
    start,
    end: roundtrip ? null : finish,
    via: thinned(parseShape(row.shape)),
    joined: row.joined,
    roundtrip,
    website: tags.website ?? null,
    wikipedia: tags.wikipedia ?? null,
    wikidata: tags.wikidata ?? null,
    difficulty: tags.sac_scale ?? tags["mtb:scale"] ?? tags.difficulty ?? null,
    highlights,
    worth: routeWorth({
      network: tags.network ?? null,
      wikipedia: tags.wikipedia ?? null,
      wikidata: tags.wikidata ?? null,
      highlights,
    }),
  };
}

/**
 * The relation's ascent, where it is a number of metres.
 *
 * Mappers write "600", "600 m" and the occasional "ca. 600"; anything
 * that does not read as a count of metres is left unsaid rather than
 * guessed at (§15.3).
 */
function wholeMetres(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$/i.exec(value);
  if (!match) return null;
  const metres = Number(match[1].replace(",", "."));
  return Number.isFinite(metres) && metres >= 0 ? Math.round(metres) : null;
}

function parseShape(geojson: string | null): RoutePoint[] {
  if (!geojson) return [];
  try {
    const parsed = JSON.parse(geojson) as { coordinates?: [number, number][] };
    return (parsed.coordinates ?? []).map(([lon, lat]) => ({ lat, lon }));
  } catch {
    return [];
  }
}

/**
 * At most `MAX_VIA_POINTS`, keeping both ends.
 *
 * Evenly spaced rather than the first sixty-four: the shape has to
 * describe the whole way, and half a way is worse than a coarse one.
 */
function thinned(points: readonly RoutePoint[]): RoutePoint[] {
  if (points.length <= MAX_VIA_POINTS) return [...points];
  const step = (points.length - 1) / (MAX_VIA_POINTS - 1);
  const out: RoutePoint[] = [];
  for (let i = 0; i < MAX_VIA_POINTS; i += 1) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

const EARTH_RADIUS_M = 6_371_008;

/** Half the side of the square around the centre, in degrees. */
export function searchBox(center: RoutePoint, radiusM: number): { dLat: number; dLon: number } {
  return { dLat: radiusM / 111_132, dLon: degreesFor(radiusM, center.lat) };
}

/**
 * Metres as degrees of longitude at this latitude — the wider of the
 * two, so a pre-filter built from it never cuts off what the exact
 * test would keep.
 */
export function degreesFor(metres: number, lat: number): number {
  const cos = Math.max(Math.cos((lat * Math.PI) / 180), 0.05);
  return metres / (111_320 * cos);
}

function resolveOrder(order: string | undefined): RouteOrder {
  if (order === undefined) return "distance";
  if (!(ROUTE_ORDERS as readonly string[]).includes(order)) {
    throw new RouteSearchError(`order must be one of ${ROUTE_ORDERS.join(", ")}`);
  }
  return order as RouteOrder;
}

function metresBetween(a: RoutePoint, b: RoutePoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function resolveKinds(requested: readonly string[] | undefined): string[] {
  if (!requested || requested.length === 0) return [...ROUTE_KINDS];
  const unknown = requested.filter((k) => !ROUTE_KINDS.includes(k as RouteKind));
  if (unknown.length > 0) {
    throw new RouteSearchError(
      `unknown route kind(s): ${unknown.join(", ")} — known: ${ROUTE_KINDS.join(", ")}`,
    );
  }
  return [...new Set(requested)];
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_ROUTE_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RouteSearchError("limit must be a positive number");
  }
  return Math.min(Math.floor(limit), MAX_ROUTE_LIMIT);
}

/**
 * The ring's near edge.
 *
 * Zero is the ordinary case and means a full circle. A near edge that
 * reaches the far one is refused rather than quietly emptied: a band
 * from 40 to 40 is somebody's mistake, and an empty list would look
 * like a region without ways.
 */
function validateMinRadius(minRadiusM: number | undefined, radiusM: number): number {
  if (minRadiusM === undefined) return 0;
  if (!Number.isFinite(minRadiusM) || minRadiusM < 0) {
    throw new RouteSearchError("minRadiusM must be zero or a positive number");
  }
  const rounded = Math.round(minRadiusM);
  if (rounded >= radiusM) {
    throw new RouteSearchError("minRadiusM must be smaller than radiusM");
  }
  return rounded;
}

export function validateRadius(radiusM: number): number {
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new RouteSearchError("radiusM must be a positive number");
  }
  if (radiusM > MAX_ROUTE_RADIUS_M) {
    throw new RouteSearchError(`radiusM may be at most ${MAX_ROUTE_RADIUS_M}`);
  }
  return Math.round(radiusM);
}

export function validatePoint(point: { lat: number; lon: number } | undefined): void {
  if (!point || typeof point !== "object") {
    throw new RouteSearchError("center is required");
  }
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new RouteSearchError(`center.lat out of range: ${point.lat}`);
  }
  if (!Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) {
    throw new RouteSearchError(`center.lon out of range: ${point.lon}`);
  }
}
