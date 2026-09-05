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
 *   - with a corridor, least detour first;
 *   - with a bounding box, by a cheap prominence proxy (has Wikidata,
 *     has Wikipedia, has a name) and then by `osm_id`, so paging is
 *     deterministic.
 */

import { poolFor } from "./db.ts";
import { foldName, foldNameSql, foldedLikePattern } from "./name-fold.ts";
import { allCategoryIds, categoryById } from "./poi-categories.ts";

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface Corridor {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  /**
   * How much longer the journey may get, in metres, counting the way
   * there and back again. A spot 500 m off a straight road costs about
   * 1000 m of budget.
   */
  detourBudgetM: number;
}

/** Exactly one of these three picks the area to search. */
export interface PoiSearchArea {
  /** Search a rectangle. */
  bbox?: BoundingBox;
  /** Search a disc. */
  center?: { lat: number; lon: number; radiusM: number };
  /** Search what lies along a journey — see `buildCorridorClause`. */
  corridor?: Corridor;
}

export interface PoiSearchOptions extends PoiSearchArea {
  /** Category ids from `poi-categories.ts`. Omitted or empty = all. */
  categories?: readonly string[];
  /**
   * Keep only spots whose name contains this, compared with diacritics
   * and case folded away (see `name-fold.ts`). Matched against `name`,
   * `name:de` and `name:en`, because the name a person has is often not
   * the one the local language uses.
   *
   * A substring rather than an exact match: a blog writes "Pastéis de
   * Belém" where OSM has "Fábrica dos Pastéis de Belém", and an exact
   * comparison would find nothing at all. Deciding which of the
   * returned rows is *the* place asked for is the caller's job — this
   * narrows, it does not resolve.
   */
  name?: string;
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
  /**
   * How much longer the journey gets if this spot is visited on the
   * way, in metres. Present only for a corridor search.
   */
  detourM: number | null;
  name: string | null;
  nameDe: string | null;
  nameEn: string | null;
  /** The matched OSM tag, e.g. `tourism=museum`. */
  kind: string | null;
  /** Category ids this POI satisfies. */
  categories: string[];
  wikidataQid: string | null;
  wikipedia: string | null;
  /**
   * Planning attributes, straight from OSM and unverified. Coarse on
   * purpose — the plan asks "open in the morning?", not "open at 09:47"
   * — and frequently absent, which the caller must treat as unknown
   * rather than as "no".
   */
  openingHours: string | null;
  cuisine: string | null;
  wheelchair: string | null;
  outdoorSeating: string | null;
  /**
   * `diet:vegetarian` / `diet:vegan` as OSM has them: "yes", "only",
   * "no", "limited" — kept verbatim rather than reduced to a boolean.
   * "limited" is a real answer and flattening it to false would turn a
   * usable place into an excluded one (§10.3).
   */
  dietVegetarian: string | null;
  dietVegan: string | null;
  /**
   * Reaching the place without a map app: reserve a table, ask whether
   * they are really open (§9.1, §10.3). Both `phone`/`website` and the
   * `contact:` prefix are in use; whichever is present is returned.
   */
  phone: string | null;
  website: string | null;
  /**
   * Facade orientation in degrees clockwise from north, in [0, 180),
   * derived from the outline at import time. Null for POIs mapped as a
   * node, and for anything imported before the outline was kept.
   */
  facadeAzimuth: number | null;
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
/** A corridor is a transfer between legs, not a route across a continent. */
export const MAX_CORRIDOR_LENGTH_M = 400_000;
/** A detour larger than this is a second destination, not a stop on the way. */
export const MAX_DETOUR_BUDGET_M = 50_000;
/**
 * Mean earth radius in metres, matching what `ST_DistanceSphere` uses.
 * Only the pre-filter radius is computed with it; the ellipse itself is
 * evaluated by PostGIS.
 */
const EARTH_RADIUS_M = 6_371_008;

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
  opening_hours: string | null;
  cuisine: string | null;
  wheelchair: string | null;
  outdoor_seating: string | null;
  diet_vegetarian: string | null;
  diet_vegan: string | null;
  phone: string | null;
  website: string | null;
  facade_azimuth: number | null;
  lat: number;
  lon: number;
  distance_m: number | null;
  detour_m: number | null;
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
  const nameClause = buildNameClause(opts.name, params);

  // One row beyond the page tells us whether a next page exists without
  // a second COUNT(*) over the same area.
  params.push(limit + 1, offset);
  const limitParam = `$${params.length - 1}`;
  const offsetParam = `$${params.length}`;

  const distanceSelect = opts.center
    ? `ST_DistanceSphere(geom, ${centrePoint(opts.center)})`
    : "NULL::double precision";
  const detourSelect = opts.corridor ? detourExpression(opts.corridor) : "NULL::double precision";

  // Nearest-first only makes sense with a centre, least-detour-first
  // only with a corridor. With neither, order by a prominence proxy so
  // the first page is the useful one, then by osm_id so paging cannot
  // repeat or skip rows.
  // Ordering must use the same measure as the reported distance. The
  // planar `<->` on geometry counts degrees, and away from the equator a
  // degree of longitude is shorter than one of latitude — so a spot due
  // east could sort behind a nearer one due north, and the list would
  // not match the metres shown beside it. Casting to geography makes the
  // operator measure on the spheroid, and it stays index-assisted.
  const orderBy = opts.center
    ? `geom::geography <-> ${centrePoint(opts.center)}::geography, osm_id`
    : opts.corridor
      // No index helps here: the detour is a sum of two distances, and
      // the ellipse clause has already cut the candidate set down to a
      // narrow band, so the sort runs over few rows.
      ? `${detourExpression(opts.corridor)}, osm_id`
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
      tags->>'opening_hours'   AS opening_hours,
      tags->>'cuisine'         AS cuisine,
      tags->>'wheelchair'      AS wheelchair,
      tags->>'outdoor_seating' AS outdoor_seating,
      tags->>'diet:vegetarian'  AS diet_vegetarian,
      tags->>'diet:vegan'       AS diet_vegan,
      -- Both spellings are in live use; the plain key wins where a POI
      -- carries each.
      COALESCE(tags->>'phone',   tags->>'contact:phone')   AS phone,
      COALESCE(tags->>'website', tags->>'contact:website') AS website,
      facade_azimuth,
      ST_Y(geom)        AS lat,
      ST_X(geom)        AS lon,
      ${distanceSelect} AS distance_m,
      ${detourSelect}   AS detour_m
    FROM osm_pois
    WHERE ${areaClause}
      AND (${tagClause})${nameClause}
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
  const given = [
    area.bbox ? "bbox" : null,
    area.center ? "center" : null,
    area.corridor ? "corridor" : null,
  ].filter((v): v is string => v !== null);
  if (given.length > 1) {
    throw new PoiSearchError(`pass exactly one of bbox, center or corridor — got ${given.join(", ")}`);
  }
  if (area.corridor) return buildCorridorClause(area.corridor, params);
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
  throw new PoiSearchError("one of bbox, center or corridor is required");
}

/**
 * "What can we see on the way without a real detour?" (§4.2).
 *
 * The spots whose journey-with-a-stop costs at most `detourBudgetM`
 * more than the direct journey are exactly those satisfying
 *
 *   dist(from, P) + dist(P, to) ≤ dist(from, to) + budget
 *
 * which is an **ellipse** with `from` and `to` as its foci. One
 * condition, no router — and once a real router exists, this stays the
 * cheap pre-filter that decides which handful of spots are worth
 * routing.
 *
 * That sum is not indexable, so it is paired with one that is: every
 * point of the ellipse lies within its semi-minor axis `b` of the
 * segment between the foci, and `ST_DWithin` against the segment uses
 * the geography index. `b ≥ budget/2` always, so the buffer also covers
 * the two ends of the ellipse, which stick out past the foci — the
 * pre-filter can never drop a point the exact clause would keep.
 *
 * With `from` equal to `to` the ellipse degenerates to a disc of radius
 * `budget/2`, which is the right answer for "a round trip of at most
 * this much extra".
 */
function buildCorridorClause(corridor: Corridor, params: unknown[]): string {
  const { from, to, detourBudgetM } = corridor;
  validatePoint(from, "corridor.from");
  validatePoint(to, "corridor.to");
  if (!Number.isFinite(detourBudgetM) || detourBudgetM <= 0) {
    throw new PoiSearchError("corridor.detourBudgetM must be a positive number");
  }
  if (detourBudgetM > MAX_DETOUR_BUDGET_M) {
    throw new PoiSearchError(`corridor.detourBudgetM may be at most ${MAX_DETOUR_BUDGET_M} m`);
  }

  const direct = greatCircleMetres(from, to);
  if (direct > MAX_CORRIDOR_LENGTH_M) {
    throw new PoiSearchError(
      `corridor may span at most ${MAX_CORRIDOR_LENGTH_M} m, got ${Math.round(direct)} m`,
    );
  }

  // Semi-minor axis of the ellipse: b = sqrt(a² - c²) with a the
  // semi-major axis and c the focal half-distance.
  const a = (direct + detourBudgetM) / 2;
  const c = direct / 2;
  // A generous margin, because `direct` is computed here on a sphere
  // while PostGIS measures the exact clause on the spheroid. The
  // pre-filter only has to not lose rows; being a little wide costs
  // nothing.
  const semiMinor = Math.sqrt(Math.max(a * a - c * c, 0)) * 1.02 + 100;

  params.push(semiMinor, detourBudgetM);
  const semiMinorParam = `$${params.length - 1}`;
  const budgetParam = `$${params.length}`;
  const fromPoint = centrePoint(from);
  const toPoint = centrePoint(to);

  return `ST_DWithin(geom::geography, ST_MakeLine(${fromPoint}, ${toPoint})::geography, ${semiMinorParam})
      AND ST_DistanceSphere(geom, ${fromPoint}) + ST_DistanceSphere(geom, ${toPoint})
          <= ST_DistanceSphere(${fromPoint}, ${toPoint}) + ${budgetParam}`;
}

/** The extra metres a stop at this spot adds to the journey. */
function detourExpression(corridor: Corridor): string {
  const fromPoint = centrePoint(corridor.from);
  const toPoint = centrePoint(corridor.to);
  return `(ST_DistanceSphere(geom, ${fromPoint}) + ST_DistanceSphere(geom, ${toPoint})
           - ST_DistanceSphere(${fromPoint}, ${toPoint}))`;
}

function validatePoint(point: { lat: number; lon: number }, label: string): void {
  if (!point || typeof point !== "object") {
    throw new PoiSearchError(`${label} is required`);
  }
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new PoiSearchError(`${label}.lat out of range: ${point.lat}`);
  }
  if (!Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) {
    throw new PoiSearchError(`${label}.lon out of range: ${point.lon}`);
  }
}

/** Haversine, used only to size the pre-filter buffer. */
function greatCircleMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The name filter, or the empty string when there is none.
 *
 * Both sides of the comparison are folded, which rules out an index on
 * the raw name — but the area clause has already narrowed the rows to
 * one disc or box, so this runs over a bounded set rather than a
 * region. Searching a whole country by name would need its own index
 * and is not what this is for.
 */
function buildNameClause(name: string | undefined, params: unknown[]): string {
  if (name === undefined) return "";
  const folded = foldName(name);
  if (folded.length === 0) {
    throw new PoiSearchError("name must not be blank");
  }
  params.push(foldedLikePattern(folded));
  const pattern = `$${params.length}`;
  const fields = ["tags->>'name'", "tags->>'name:de'", "tags->>'name:en'"];
  const clauses = fields.map((f) => `${foldNameSql(`coalesce(${f}, '')`)} LIKE ${pattern}`);
  return `\n      AND (${clauses.join(" OR ")})`;
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
    detourM: row.detour_m === null ? null : Number(row.detour_m),
    name: row.name,
    nameDe: row.name_de,
    nameEn: row.name_en,
    kind: row.kind,
    categories: matchedCategories(row.tags ?? {}, requested),
    wikidataQid: row.wikidata,
    wikipedia: row.wikipedia,
    openingHours: row.opening_hours,
    cuisine: row.cuisine,
    wheelchair: row.wheelchair,
    outdoorSeating: row.outdoor_seating,
    dietVegetarian: row.diet_vegetarian,
    dietVegan: row.diet_vegan,
    phone: row.phone,
    website: row.website,
    facadeAzimuth: row.facade_azimuth === null ? null : Number(row.facade_azimuth),
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
