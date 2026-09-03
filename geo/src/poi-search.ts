/**
 * Area search over `osm_pois` — the candidate source for trip planning.
 *
 * Distinct from `findPoiCandidates` in `pois.ts`, which answers "what
 * could this photo show?" for one coordinate and returns the nearest
 * handful. Planning asks the opposite way round: "what is worth seeing
 * in this area?", over a bounding box or a generous radius, filtered by
 * category (see `poi-categories.ts`), and in pages.
 *
 * Deliberately **not** a ranking. Whether a spot is worth a block
 * depends on interests, votes, opening hours, weather and light — all
 * of which live in the planner, not in a geo lookup. This returns
 * candidates in a stable, explainable order and stops there:
 *
 *   - with a centre, nearest first;
 *   - with a bounding box, by a cheap prominence proxy (has Wikidata,
 *     has Wikipedia, has a name) and then by `osm_id`, so paging is
 *     deterministic.
 */

import { poolFor } from "./db.ts";
import { allCategoryIds, categoryById } from "./poi-categories.ts";

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface PoiSearchArea {
  /** Search a rectangle. Mutually exclusive with `center`. */
  bbox?: BoundingBox;
  /** Search a disc. Mutually exclusive with `bbox`. */
  center?: { lat: number; lon: number; radiusM: number };
}

export interface PoiSearchOptions extends PoiSearchArea {
  /** Category ids from `poi-categories.ts`. Omitted or empty = all. */
  categories?: readonly string[];
  /** Page size. Defaults to 200, capped at MAX_LIMIT. */
  limit?: number;
  /** Rows to skip, for paging. Defaults to 0. */
  offset?: number;
}

export interface PoiSearchResult {
  osmRef: string;
  type: "node" | "way" | "relation";
  id: number;
  lat: number;
  lon: number;
  /** Present only when the search had a centre. */
  distanceM: number | null;
  name: string | null;
  nameDe: string | null;
  /** Stays null until the import carries `name:en` (step 4). */
  nameEn: string | null;
  /** The matched OSM tag, e.g. `tourism=museum`. */
  kind: string | null;
  /** Category ids this POI satisfies. */
  categories: string[];
  wikidataQid: string | null;
  wikipedia: string | null;
}

export interface PoiSearchPage {
  spots: PoiSearchResult[];
  /** True when another page exists at `offset + limit`. */
  hasMore: boolean;
}

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;
/** Guards against a radius that would scan a whole country. */
export const MAX_RADIUS_M = 50_000;
/** Guards against a bbox that would do the same, in degrees per side. */
export const MAX_BBOX_SPAN_DEG = 2;

export class PoiSearchError extends Error {}

type Row = {
  osm_type: string;
  osm_id: string; // bigint arrives as string from node-pg
  name: string | null;
  name_de: string | null;
  name_en: string | null;
  kind: string | null;
  tags: Record<string, string> | null;
  wikidata: string | null;
  wikipedia: string | null;
  lat: number;
  lon: number;
  distance_m: number | null;
};

export async function searchPois(
  database: string,
  opts: PoiSearchOptions,
): Promise<PoiSearchPage> {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const categories = resolveCategories(opts.categories);

  const params: unknown[] = [];
  const areaClause = buildAreaClause(opts, params);
  const tagClause = buildTagClause(categories, params);

  // One row beyond the page tells us whether a next page exists without
  // a second COUNT(*) over the same area.
  params.push(limit + 1, offset);
  const limitParam = `$${params.length - 1}`;
  const offsetParam = `$${params.length}`;

  const distanceSelect = opts.center
    ? `ST_DistanceSphere(geom, ${centrePoint(opts.center)})`
    : "NULL::double precision";

  // Nearest-first only makes sense with a centre. Without one, order by a
  // prominence proxy so the first page is the useful one, then by osm_id
  // so paging cannot repeat or skip rows.
  const orderBy = opts.center
    ? `geom <-> ${centrePoint(opts.center)}, osm_id`
    : `((tags ? 'wikidata')::int + (tags ? 'wikipedia')::int + (tags ? 'name')::int) DESC, osm_id`;

  const sql = `
    SELECT
      osm_type,
      osm_id::text      AS osm_id,
      tags->>'name'     AS name,
      tags->>'name:de'  AS name_de,
      tags->>'name:en'  AS name_en,
      kind,
      tags,
      tags->>'wikidata' AS wikidata,
      tags->>'wikipedia' AS wikipedia,
      ST_Y(geom)        AS lat,
      ST_X(geom)        AS lon,
      ${distanceSelect} AS distance_m
    FROM osm_pois
    WHERE ${areaClause}
      AND (${tagClause})
    ORDER BY ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const res = await poolFor(database).query<Row>(sql, params);
  const hasMore = res.rows.length > limit;
  const rows = hasMore ? res.rows.slice(0, limit) : res.rows;
  return { spots: rows.map((r) => toResult(r, categories)), hasMore };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new PoiSearchError("limit must be a positive number");
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isFinite(offset) || offset < 0) {
    throw new PoiSearchError("offset must be zero or positive");
  }
  return Math.floor(offset);
}

function resolveCategories(requested: readonly string[] | undefined): string[] {
  if (!requested || requested.length === 0) return allCategoryIds();
  const unknown = requested.filter((id) => !categoryById(id));
  if (unknown.length > 0) {
    throw new PoiSearchError(`unknown categories: ${unknown.join(", ")}`);
  }
  return [...new Set(requested)];
}

function centrePoint(center: { lat: number; lon: number }): string {
  return `ST_SetSRID(ST_Point(${numeric(center.lon)}, ${numeric(center.lat)}), 4326)`;
}

/**
 * Coordinates are interpolated rather than parameterised because they
 * appear in both the SELECT and the ORDER BY, where a repeated
 * placeholder would have to be threaded through twice. `numeric`
 * rejects anything that is not a finite number, so no user input
 * reaches the string.
 */
function numeric(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PoiSearchError(`expected a finite number, got ${String(value)}`);
  }
  return value.toString();
}

function buildAreaClause(area: PoiSearchArea, params: unknown[]): string {
  if (area.bbox && area.center) {
    throw new PoiSearchError("pass either bbox or center, not both");
  }
  if (area.bbox) {
    const { minLat, minLon, maxLat, maxLon } = area.bbox;
    for (const [name, v] of Object.entries(area.bbox)) {
      if (!Number.isFinite(v)) throw new PoiSearchError(`bbox.${name} must be a finite number`);
    }
    if (minLat >= maxLat || minLon >= maxLon) {
      throw new PoiSearchError("bbox min values must be smaller than max values");
    }
    if (maxLat - minLat > MAX_BBOX_SPAN_DEG || maxLon - minLon > MAX_BBOX_SPAN_DEG) {
      throw new PoiSearchError(`bbox may span at most ${MAX_BBOX_SPAN_DEG}° per side`);
    }
    params.push(minLon, minLat, maxLon, maxLat);
    const n = params.length;
    return `geom && ST_MakeEnvelope($${n - 3}, $${n - 2}, $${n - 1}, $${n}, 4326)`;
  }
  if (area.center) {
    const { lat, lon, radiusM } = area.center;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new PoiSearchError(`center.lat out of range: ${lat}`);
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new PoiSearchError(`center.lon out of range: ${lon}`);
    }
    if (!Number.isFinite(radiusM) || radiusM <= 0) {
      throw new PoiSearchError("center.radiusM must be a positive number");
    }
    if (radiusM > MAX_RADIUS_M) {
      throw new PoiSearchError(`center.radiusM may be at most ${MAX_RADIUS_M} m`);
    }
    params.push(radiusM);
    return `ST_DWithin(geom::geography, ${centrePoint(area.center)}::geography, $${params.length})`;
  }
  throw new PoiSearchError("either bbox or center is required");
}

function buildTagClause(categories: readonly string[], params: unknown[]): string {
  const parts: string[] = [];
  for (const id of categories) {
    const category = categoryById(id);
    if (!category) continue;
    for (const rule of category.rules) {
      params.push(rule.key);
      const keyParam = `$${params.length}`;
      if (!rule.values || rule.values.length === 0) {
        parts.push(`tags ? ${keyParam}`);
        continue;
      }
      params.push([...rule.values]);
      parts.push(`tags->>${keyParam} = ANY($${params.length}::text[])`);
    }
  }
  // resolveCategories guarantees at least one category, and every
  // category carries at least one rule — but an empty disjunction would
  // silently mean "everything", so fail loudly instead.
  if (parts.length === 0) throw new PoiSearchError("no tag predicates for the given categories");
  return parts.join(" OR ");
}

function toResult(row: Row, requested: readonly string[]): PoiSearchResult {
  const type = osmTypeFromCode(row.osm_type);
  return {
    osmRef: `${type}:${row.osm_id}`,
    type,
    id: Number(row.osm_id),
    lat: Number(row.lat),
    lon: Number(row.lon),
    distanceM: row.distance_m === null ? null : Number(row.distance_m),
    name: row.name,
    nameDe: row.name_de,
    nameEn: row.name_en,
    kind: row.kind,
    categories: matchedCategories(row.tags ?? {}, requested),
    wikidataQid: row.wikidata,
    wikipedia: row.wikipedia,
  };
}

function matchedCategories(
  tags: Record<string, string>,
  requested: readonly string[],
): string[] {
  const matched: string[] = [];
  for (const id of requested) {
    const category = categoryById(id);
    if (!category) continue;
    const hit = category.rules.some((rule) => {
      const value = tags[rule.key];
      if (value === undefined || value === "") return false;
      return !rule.values || rule.values.length === 0 || rule.values.includes(value);
    });
    if (hit) matched.push(id);
  }
  return matched;
}

/** osm2pgsql stores the type as a single character. */
function osmTypeFromCode(code: string): "node" | "way" | "relation" {
  switch (code) {
    case "N":
      return "node";
    case "W":
      return "way";
    case "R":
      return "relation";
    default:
      return "node";
  }
}
