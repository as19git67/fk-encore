/**
 * One route's course, in full (§4.7).
 *
 * `route-search.ts` answers with a *simplified* shape: fifty metres of
 * tolerance, at most sixty-four points, because that shape is carried
 * in a plan, drawn on a map and taken offline. It is the right answer
 * there and the wrong answer here.
 *
 * A file somebody imports into Komoot, Organic Maps or a Garmin is a
 * different thing from a line on a map. Sixty-four points across twenty
 * kilometres cut every switchback off a mountain path; the track that
 * comes out is not the way that is signposted, and following it would
 * mean leaving the path. So this reads the geometry as it was imported
 * — no simplification, no thinning — and it exists as its own function
 * for exactly that reason, so that nobody can accidentally export the
 * map's shape.
 *
 * ## One way, in order
 *
 * A relation is a bag of member ways, in whatever order and whatever
 * direction the mappers left them. `ST_LineMerge` joins what joins and
 * hands back a `LINESTRING`; where the members do not meet it hands
 * back a `MULTILINESTRING`, and its parts are then *segments of the
 * same way with gaps between them*, not alternatives.
 *
 * Both are answered, and which one it is, is said: a caller writing a
 * GPX file wants one `<trkseg>` per part rather than one track pretending
 * the gaps are not there (§15.3 — never claim what is not known).
 */

import { poolFor } from "./db.ts";
import { RouteSearchError } from "./route-search.ts";

export interface GeometryPoint {
  lat: number;
  lon: number;
}

export interface RouteGeometry {
  osmRef: string;
  id: number;
  name: string;
  /** hiking | foot | bicycle | mtb. */
  route: string;
  /** Metres along the way, measured from the geometry. */
  lengthM: number;
  /** Metres of climb, where the relation says. Never guessed. */
  ascentM: number | null;
  network: string | null;
  ref: string | null;
  website: string | null;
  /**
   * The course, one array per connected part.
   *
   * One part means the relation joins into a single way. Several mean
   * it has gaps — the parts are pieces of one route in order along it,
   * not choices between routes.
   */
  parts: GeometryPoint[][];
  /** True when the members join into a single way. */
  joined: boolean;
}

interface Row {
  osm_id: string;
  route: string;
  name: string;
  tags: Record<string, string> | null;
  length_m: number;
  joined: boolean;
  shape: string | null;
}

/**
 * The full course of one route, or null when that database has no such
 * relation.
 *
 * Null rather than an error: a route that is no longer in the region
 * (a re-import dropped it, a mapper deleted the relation) is an
 * ordinary answer for a link somebody saved yesterday.
 */
export async function routeGeometry(
  database: string,
  osmId: number,
): Promise<RouteGeometry | null> {
  if (!Number.isInteger(osmId) || osmId <= 0) {
    throw new RouteSearchError(`osmId must be a positive integer, got ${osmId}`);
  }

  const sql = `
    WITH one AS (
      SELECT osm_id, route, name, tags, geom
        FROM osm_routes
       WHERE osm_id = $1
    ), merged AS (
      SELECT one.*, ST_LineMerge(geom) AS line FROM one
    )
    SELECT
      osm_id::text AS osm_id,
      route,
      name,
      tags,
      ST_Length(geom::geography) AS length_m,
      GeometryType(line) = 'LINESTRING' AS joined,
      ST_AsGeoJSON(line) AS shape
      FROM merged
  `;

  let rows: Row[];
  try {
    const res = await poolFor(database).query<Row>(sql, [osmId]);
    rows = res.rows;
  } catch (err) {
    // 42P01: a region imported before routes were part of the style.
    // An older import, not a broken one — and for one relation the
    // honest answer is the same as "not here".
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }

  const row = rows[0];
  if (!row) return null;

  const tags = row.tags ?? {};
  return {
    osmRef: `relation:${row.osm_id}`,
    id: Number(row.osm_id),
    name: row.name,
    route: row.route,
    lengthM: Math.round(row.length_m),
    ascentM: wholeMetres(tags.ascent),
    network: tags.network ?? null,
    ref: tags.ref ?? null,
    website: tags.website ?? null,
    parts: parseParts(row.shape),
    joined: row.joined === true,
  };
}

/**
 * The relation's ascent, where it is a number of metres.
 *
 * The same reading as in `route-search.ts`, and deliberately a second
 * copy rather than a shared helper: these two answer different
 * questions about the same tag and one of them may learn something the
 * other must not. Both refuse anything that does not read as a count
 * of metres rather than guess at it (§15.3).
 */
function wholeMetres(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$/i.exec(value);
  if (!match) return null;
  const metres = Number(match[1].replace(",", "."));
  return Number.isFinite(metres) && metres >= 0 ? Math.round(metres) : null;
}

/**
 * GeoJSON to parts.
 *
 * `ST_LineMerge` gives a `LineString` when the members join and a
 * `MultiLineString` when they do not, so both shapes arrive here and
 * both become the same thing: an array of parts.
 */
function parseParts(geojson: string | null): GeometryPoint[][] {
  if (!geojson) return [];
  let parsed: { type?: string; coordinates?: unknown };
  try {
    parsed = JSON.parse(geojson) as { type?: string; coordinates?: unknown };
  } catch {
    return [];
  }

  const points = (coords: unknown): GeometryPoint[] =>
    Array.isArray(coords)
      ? coords
        .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2)
        .map(([lon, lat]) => ({ lat, lon }))
      : [];

  if (parsed.type === "LineString") {
    const part = points(parsed.coordinates);
    return part.length >= 2 ? [part] : [];
  }
  if (parsed.type === "MultiLineString" && Array.isArray(parsed.coordinates)) {
    return parsed.coordinates.map(points).filter((part) => part.length >= 2);
  }
  return [];
}
