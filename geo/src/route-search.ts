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
const SIMPLIFY_TOLERANCE_DEG = 0.0005;

/** At most this many points in the shape, however long the way. */
export const MAX_VIA_POINTS = 64;

export interface RouteSearchOptions {
  center: { lat: number; lon: number };
  radiusM: number;
  /** Omitted means all four kinds. */
  kinds?: readonly string[];
  limit?: number;
}

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
  /** How hard it is, in whatever scale the relation uses. */
  difficulty: string | null;
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
}

export async function searchRoutes(
  database: string,
  opts: RouteSearchOptions,
): Promise<RouteSearchPage> {
  validatePoint(opts.center);
  const radiusM = validateRadius(opts.radiusM);
  const limit = clampLimit(opts.limit);
  const kinds = resolveKinds(opts.kinds);

  const centre = `ST_SetSRID(ST_Point($1, $2), 4326)::geography`;
  const sql = `
    WITH near AS (
      SELECT osm_id, route, name, tags, geom,
             ST_Distance(geom::geography, ${centre}) AS distance_m
        FROM osm_routes
       WHERE ST_DWithin(geom::geography, ${centre}, $3)
         AND route = ANY($4::text[])
       ORDER BY distance_m, osm_id
       LIMIT $5
    ), merged AS (
      SELECT near.*, ST_LineMerge(geom) AS line FROM near
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
           END AS shape
      FROM merged
     ORDER BY distance_m, osm_id
  `;

  let rows: Row[];
  try {
    const res = await poolFor(database).query<Row>(sql, [
      opts.center.lon,
      opts.center.lat,
      radiusM,
      kinds,
      limit + 1,
    ]);
    rows = res.rows;
  } catch (err) {
    // 42P01: the region was imported before routes were part of the
    // style. An older import, not a broken one.
    if ((err as { code?: string }).code === "42P01") {
      return { routes: [], hasMore: false, imported: false };
    }
    throw err;
  }

  const hasMore = rows.length > limit;
  return {
    routes: (hasMore ? rows.slice(0, limit) : rows).map(toResult),
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
    difficulty: tags.sac_scale ?? tags["mtb:scale"] ?? tags.difficulty ?? null,
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

function validateRadius(radiusM: number): number {
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new RouteSearchError("radiusM must be a positive number");
  }
  if (radiusM > MAX_ROUTE_RADIUS_M) {
    throw new RouteSearchError(`radiusM may be at most ${MAX_ROUTE_RADIUS_M}`);
  }
  return Math.round(radiusM);
}

function validatePoint(point: { lat: number; lon: number } | undefined): void {
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
