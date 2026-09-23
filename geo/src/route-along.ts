/**
 * What to look at along one way, for its pictures (§4.7).
 *
 * OpenStreetMap holds no photographs. What it does hold is where a way
 * runs and which of the things beside it have a Wikidata item — and
 * Wikidata and Commons hold the pictures. This hands the trip planner
 * the two keys it needs to go and ask:
 *
 *   - **The subjects**: highlights along the line (the same kinds and
 *     the same 150 m as the ranking, `route-worth.ts`) that carry a
 *     `wikidata` tag. Their chosen image is the best picture there is
 *     of a summit or a castle.
 *   - **Points along the stretch**, spread over it, for a search of
 *     Commons by where a photo was taken. That is where the pictures
 *     of the way itself come from, when anybody took one.
 *
 * Both only on the stretch inside the square around the leg, like the
 * ranking: a thousand-kilometre trail's pictures from the far end are
 * not what somebody staying here would walk into.
 */

import { poolFor } from "./db.ts";
import {
  degreesFor,
  RouteSearchError,
  searchBox,
  SIMPLIFY_TOLERANCE_DEG,
  SUBDIVIDE_VERTICES,
  validatePoint,
  validateRadius,
} from "./route-search.ts";
import {
  HIGHLIGHT_ALONG_M,
  HIGHLIGHT_CATEGORIES,
  HIGHLIGHT_KINDS,
  type HighlightCategory,
  UNNAMED_HIGHLIGHT_KINDS,
} from "./route-worth.ts";

/** How many points along the stretch a photo search gets. */
export const ALONG_SAMPLES = 6;
/** How many subjects at most — each is a picture, and a strip is short. */
export const ALONG_SUBJECTS = 8;

export interface AlongPoint {
  lat: number;
  lon: number;
}

export interface AlongSubject {
  category: HighlightCategory;
  name: string | null;
  /** Bare QID, "Q123". */
  wikidata: string;
  lat: number;
  lon: number;
}

export interface RouteAlong {
  osmRef: string;
  /** Most striking first, by the order the row lists categories in. */
  subjects: AlongSubject[];
  /**
   * Spread over the vertices of the stretch near the centre — even by
   * count, not by metre, which for a simplified line is close enough
   * to put one search at each end and the rest in between.
   */
  samples: AlongPoint[];
}

export interface RouteAlongOptions {
  center: { lat: number; lon: number };
  radiusM: number;
}

interface Row {
  local: string | null;
  subjects: { kind: string; name: string | null; wikidata: string; lat: number; lon: number }[] | null;
}

/**
 * The subjects and sample points of one way, or null when the region
 * has no such relation (a re-import dropped it) or no routes at all.
 */
export async function routeAlong(
  database: string,
  osmId: number,
  opts: RouteAlongOptions,
): Promise<RouteAlong | null> {
  if (!Number.isInteger(osmId) || osmId <= 0) {
    throw new RouteSearchError(`osmId must be a positive integer, got ${osmId}`);
  }
  validatePoint(opts.center);
  const radiusM = validateRadius(opts.radiusM);
  const box = searchBox(opts.center, radiusM);

  const sql = `
    WITH one AS (
      SELECT ST_ClipByBox2D(
               geom,
               ST_Expand(ST_SetSRID(ST_Point($2, $3), 4326), $4, $5)::box2d
             ) AS local
        FROM osm_routes
       WHERE osm_id = $1
    )
    SELECT
      ST_AsGeoJSON(ST_SimplifyPreserveTopology(one.local, ${SIMPLIFY_TOLERANCE_DEG})) AS local,
      found.subjects
      FROM one
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'kind', kind, 'name', name, 'wikidata', wikidata, 'lat', lat, 'lon', lon))
                 AS subjects
          FROM (
            SELECT DISTINCT ON (p.osm_type, p.osm_id)
                   p.kind, p.name, p.tags->>'wikidata' AS wikidata,
                   ST_Y(p.geom) AS lat, ST_X(p.geom) AS lon
              FROM ST_Subdivide(one.local, ${SUBDIVIDE_VERTICES}) AS piece
              JOIN osm_pois p ON p.geom && ST_Expand(piece, $9)
             WHERE p.kind = ANY($6::text[])
               AND (p.name IS NOT NULL OR p.kind = ANY($7::text[]))
               AND p.tags->>'wikidata' ~ '^Q[0-9]+$'
               AND ST_DWithin(p.geom::geography, piece::geography, $8)
          ) hits
      ) found ON true
  `;

  let rows: Row[];
  try {
    const res = await poolFor(database).query<Row>(sql, [
      osmId,
      opts.center.lon,
      opts.center.lat,
      box.dLon,
      box.dLat,
      Object.keys(HIGHLIGHT_KINDS),
      UNNAMED_HIGHLIGHT_KINDS,
      HIGHLIGHT_ALONG_M,
      degreesFor(HIGHLIGHT_ALONG_M, opts.center.lat),
    ]);
    rows = res.rows;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    osmRef: `relation:${osmId}`,
    subjects: subjectsFrom(row.subjects),
    samples: evenlySpaced(pointsOf(row.local), ALONG_SAMPLES),
  };
}

/**
 * Ordered as the row lists categories — a summit before a café — and
 * one per item even where two POIs share a QID (a castle mapped as a
 * node and as its outline).
 */
export function subjectsFrom(raw: Row["subjects"]): AlongSubject[] {
  const rank = (category: HighlightCategory) => HIGHLIGHT_CATEGORIES.indexOf(category);
  const seen = new Set<string>();
  const out: AlongSubject[] = [];
  const sorted = (raw ?? [])
    .map((s) => ({ ...s, category: HIGHLIGHT_KINDS[s.kind] }))
    .filter((s): s is typeof s & { category: HighlightCategory } => s.category !== undefined)
    .sort((a, b) => rank(a.category) - rank(b.category) || (a.name ?? "").localeCompare(b.name ?? ""));
  for (const s of sorted) {
    if (seen.has(s.wikidata)) continue;
    seen.add(s.wikidata);
    out.push({ category: s.category, name: s.name, wikidata: s.wikidata, lat: s.lat, lon: s.lon });
    if (out.length >= ALONG_SUBJECTS) break;
  }
  return out;
}

/** Every vertex of a (Multi)LineString's GeoJSON, parts in order. */
export function pointsOf(geojson: string | null): AlongPoint[] {
  if (!geojson) return [];
  try {
    const parsed = JSON.parse(geojson) as {
      type?: string;
      coordinates?: unknown;
      geometries?: { type?: string; coordinates?: unknown }[];
    };
    const lines: [number, number][][] = [];
    const collect = (type: string | undefined, coords: unknown) => {
      if (type === "LineString") lines.push(coords as [number, number][]);
      if (type === "MultiLineString") lines.push(...(coords as [number, number][][]));
    };
    // A clip can come back as a collection when it cuts a way into
    // pieces of different kinds; its lines are what matter.
    if (parsed.type === "GeometryCollection") {
      for (const g of parsed.geometries ?? []) collect(g.type, g.coordinates);
    } else {
      collect(parsed.type, parsed.coordinates);
    }
    return lines.flat().map(([lon, lat]) => ({ lat, lon }));
  } catch {
    return [];
  }
}

/** `count` points spread over the list, both ends kept. */
export function evenlySpaced(points: readonly AlongPoint[], count: number): AlongPoint[] {
  if (points.length <= count) return [...points];
  if (count <= 1) return [points[0]];
  const step = (points.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => points[Math.round(i * step)]);
}
