/**
 * Places within reach that would carry a day of their own (§4.6).
 *
 * Four days in a town of seven thousand: the pool does not carry them,
 * and every person you ask says "you are an hour from Florence". A
 * planner that keeps quiet about that is not restrained, it is
 * useless. But a suggestion needs something to point at, and there is
 * no place database — `place` nodes are not imported.
 *
 * Two sources already in every region answer it, and they count the
 * same thing: **what a day there would be made of**, measured in the
 * spots the pool would itself rate as worth a block (§10.5).
 *
 *   - **The named area** (`osm_admin`). A municipality holding forty
 *     prominent spots is a day out; one holding two is not. The most
 *     local named area wins, because "Toscana" is not a destination
 *     and "Firenze" is.
 *   - **The cluster** (a coarse grid) for everything that lies in no
 *     such area — a lake shore, a valley, a monastery on a hill. It
 *     needs no boundaries and finds the destination that is not a
 *     municipality of its own.
 *
 * What this module deliberately does **not** do is decide. It counts
 * and hands back the count; whether four days are undersupplied and an
 * hour of driving is worth it belongs to the trip, not to the map
 * (see `trip-planner/thin-pool.ts` and `trip-planner/day-trip.ts`).
 *
 * The ring matters as much as the radius. Spots inside the leg's own
 * search are already in its pool — counting them again would propose a
 * day trip to where the travellers already are.
 */

import { poolFor } from "./db.ts";

export class DayTargetError extends Error {}

/** Nothing nearer than this counts as somewhere else to go. */
export const MIN_DAY_TARGET_RADIUS_M = 5_000;
export const MAX_DAY_TARGET_RADIUS_M = 150_000;
export const DEFAULT_DAY_TARGET_LIMIT = 10;
export const MAX_DAY_TARGET_LIMIT = 50;

/**
 * Which admin levels may name a destination.
 *
 * 7 to 9 is the municipality in most of Europe — the level at which a
 * name is somewhere you would say you are going. Regions and provinces
 * sit above it and are not destinations; a district of a city sits
 * below and would split one destination into six.
 */
export const MIN_ADMIN_LEVEL = 7;
export const MAX_ADMIN_LEVEL = 9;

/**
 * How coarse the fallback grid is, in degrees.
 *
 * A twentieth of a degree is about five and a half kilometres: small
 * enough that two destinations half an hour apart do not merge, large
 * enough that one destination is not cut into four cells. It is a
 * cluster, not a boundary, and the answer says which it is.
 */
const GRID_DEG = 0.05;

/**
 * What marks a spot as worth a block, in the same terms the pool uses
 * (`trip-planner/candidates.ts`): somebody linked it to Wikidata or
 * Wikipedia, or a mapper tagged it as a thing to go and see. A name
 * alone is not prominence — every savings bank has one.
 */
const PROMINENT_KINDS = [
  "tourism=attraction",
  "tourism=museum",
  "tourism=gallery",
  "tourism=viewpoint",
  "tourism=monument",
  "tourism=zoo",
];

export interface DayTargetOptions {
  center: { lat: number; lon: number };
  /**
   * Nothing nearer than this. Below it lies the leg's own pool, and a
   * day trip to where you already are is not a suggestion.
   */
  minRadiusM: number;
  maxRadiusM: number;
  limit?: number;
}

export interface DayTarget {
  /** What to call it: the area's name, or the cluster's best-known spot. */
  name: string;
  /** "admin" when a named area holds it, "cluster" when the grid found it. */
  source: "admin" | "cluster";
  /** The area's OSM reference, where one named it. */
  osmRef: string | null;
  adminLevel: number | null;
  /**
   * Where the spots are — their centre of gravity, not the area's.
   * A municipality reaching ten kilometres into the hills is still
   * visited where its spots stand.
   */
  at: { lat: number; lon: number };
  /** Straight line from the search centre to that point, in metres. */
  distanceM: number;
  /** How many spots worth a block stand there. */
  spotCount: number;
  /** How many of those carry a Wikidata or Wikipedia link. */
  linkedCount: number;
  /** A few of them by name, so a suggestion can say what is there. */
  examples: string[];
}

export interface DayTargetPage {
  targets: DayTarget[];
  hasMore: boolean;
}

interface Row {
  name: string;
  source: "admin" | "cluster";
  osm_id: string | null;
  admin_level: number | null;
  lat: number;
  lon: number;
  distance_m: number;
  spot_count: string;
  linked_count: string;
  examples: string[];
}

export async function searchDayTargets(
  database: string,
  opts: DayTargetOptions,
): Promise<DayTargetPage> {
  validatePoint(opts.center);
  const { minRadiusM, maxRadiusM } = validateRing(opts);
  const limit = clampLimit(opts.limit);

  const centre = `ST_SetSRID(ST_Point($1, $2), 4326)::geography`;
  // One pass over the ring, then two ways of grouping what it found.
  // A spot lands in exactly one of them: inside a named municipality
  // it belongs to that place, outside every one it belongs to its
  // cluster. Counting it in both would make the same forty spots look
  // like eighty.
  const sql = `
    WITH prominent AS (
      SELECT osm_id, geom, tags,
             (tags ? 'wikidata' OR tags ? 'wikipedia') AS linked,
             ST_Distance(geom::geography, ${centre}) AS distance_m
        FROM osm_pois
       WHERE tags ? 'name'
         AND (tags ? 'wikidata' OR tags ? 'wikipedia' OR kind = ANY($5::text[]))
         AND ST_DWithin(geom::geography, ${centre}, $4)
         AND NOT ST_DWithin(geom::geography, ${centre}, $3)
    ), placed AS (
      SELECT DISTINCT ON (p.osm_id)
             p.osm_id, a.osm_id AS admin_id, a.name AS admin_name, a.admin_level
        FROM prominent p
        JOIN osm_admin a
          ON a.name IS NOT NULL
         AND a.admin_level BETWEEN $6 AND $7
         AND ST_Contains(a.geom, p.geom)
       -- The most local named area: a spot is in Firenze before it is
       -- in its province.
       ORDER BY p.osm_id, a.admin_level DESC
    ), joined AS (
      SELECT p.*, pl.admin_id, pl.admin_name, pl.admin_level
        FROM prominent p
        LEFT JOIN placed pl ON pl.osm_id = p.osm_id
    ), by_admin AS (
      SELECT admin_name AS name,
             'admin'::text AS source,
             admin_id::text AS osm_id,
             admin_level,
             ST_Y(ST_Centroid(ST_Collect(geom))) AS lat,
             ST_X(ST_Centroid(ST_Collect(geom))) AS lon,
             count(*) AS spot_count,
             count(*) FILTER (WHERE linked) AS linked_count,
             (array_agg(tags->>'name' ORDER BY linked DESC, tags->>'name'))[1:3] AS examples
        FROM joined
       WHERE admin_id IS NOT NULL
       GROUP BY admin_id, admin_name, admin_level
    ), by_cluster AS (
      SELECT (array_agg(tags->>'name' ORDER BY linked DESC, tags->>'name'))[1] AS name,
             'cluster'::text AS source,
             NULL::text AS osm_id,
             NULL::int AS admin_level,
             ST_Y(ST_Centroid(ST_Collect(geom))) AS lat,
             ST_X(ST_Centroid(ST_Collect(geom))) AS lon,
             count(*) AS spot_count,
             count(*) FILTER (WHERE linked) AS linked_count,
             (array_agg(tags->>'name' ORDER BY linked DESC, tags->>'name'))[1:3] AS examples
        FROM joined
       WHERE admin_id IS NULL
       GROUP BY ST_SnapToGrid(geom, ${GRID_DEG})
    ), combined AS (
      SELECT * FROM by_admin UNION ALL SELECT * FROM by_cluster
    )
    SELECT name, source, osm_id, admin_level, lat, lon,
           spot_count::text AS spot_count,
           linked_count::text AS linked_count,
           examples,
           ST_Distance(ST_SetSRID(ST_Point(lon, lat), 4326)::geography, ${centre}) AS distance_m
      FROM combined
     WHERE name IS NOT NULL
     -- The strongest destination first: this list is read from the top
     -- and the planner offers one of it (§4.6).
     ORDER BY spot_count DESC, linked_count DESC, name
     LIMIT $8
  `;

  let rows: Row[];
  try {
    const res = await poolFor(database).query<Row>(sql, [
      opts.center.lon,
      opts.center.lat,
      minRadiusM,
      maxRadiusM,
      PROMINENT_KINDS,
      MIN_ADMIN_LEVEL,
      MAX_ADMIN_LEVEL,
      limit + 1,
    ]);
    rows = res.rows;
  } catch (err) {
    // Both tables have been part of every import since the beginning
    // (they are two of the three the readiness check requires), so a
    // failure here is a failure and not an older region.
    throw new DayTargetError(
      `day-target search failed on ${database}: ${(err as Error).message}`,
    );
  }

  const hasMore = rows.length > limit;
  return {
    targets: (hasMore ? rows.slice(0, limit) : rows).map(toTarget),
    hasMore,
  };
}

function toTarget(row: Row): DayTarget {
  return {
    name: row.name,
    source: row.source,
    osmRef: row.osm_id ? `area:${row.osm_id}` : null,
    adminLevel: row.admin_level,
    at: { lat: row.lat, lon: row.lon },
    distanceM: Math.round(row.distance_m),
    spotCount: Number(row.spot_count),
    linkedCount: Number(row.linked_count),
    examples: (row.examples ?? []).filter((name): name is string => Boolean(name)),
  };
}

function validatePoint(point: { lat: number; lon: number }): void {
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new DayTargetError(`lat out of range: ${point.lat}`);
  }
  if (!Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) {
    throw new DayTargetError(`lon out of range: ${point.lon}`);
  }
}

function validateRing(opts: DayTargetOptions): { minRadiusM: number; maxRadiusM: number } {
  const minRadiusM = Math.max(
    MIN_DAY_TARGET_RADIUS_M,
    Math.round(Number.isFinite(opts.minRadiusM) ? opts.minRadiusM : 0),
  );
  if (!Number.isFinite(opts.maxRadiusM) || opts.maxRadiusM <= 0) {
    throw new DayTargetError("maxRadiusM must be a positive number");
  }
  const maxRadiusM = Math.min(Math.round(opts.maxRadiusM), MAX_DAY_TARGET_RADIUS_M);
  if (maxRadiusM <= minRadiusM) {
    throw new DayTargetError("maxRadiusM must be greater than minRadiusM");
  }
  return { minRadiusM, maxRadiusM };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_DAY_TARGET_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new DayTargetError("limit must be a positive number");
  }
  return Math.min(Math.round(limit), MAX_DAY_TARGET_LIMIT);
}
