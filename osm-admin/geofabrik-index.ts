/**
 * Geofabrik index loader and point-in-polygon lookup.
 *
 * The Geofabrik download server publishes a single GeoJSON file
 * (`index-v1.json`, ~1 MB) that lists every available regional OSM
 * extract with its bounding polygon and download URL. We use it for
 * two things:
 *
 *   1. Given a photo's GPS coordinates, pick the smallest regional
 *      extract that covers the point. That's the region we need to
 *      import for POI detection on that photo.
 *
 *   2. Surface the metadata (extract URL, name, hierarchy) so the
 *      admin UI can show "we'd need to import Bayern (≈ 600 MB)".
 *
 * The index is cached on disk (default TTL 7 days). The cache is also
 * the offline fallback — if a refresh fetch fails we keep using the
 * stale file rather than blocking POI detection.
 *
 * Heavy parsing (polygon flattening into a typed in-memory structure)
 * happens once per process; subsequent lookups are constant-time per
 * candidate region.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Minimal GeoJSON polygon types — we only consume Polygon / MultiPolygon. */
type Ring = [number, number][];
type PolygonGeom = { type: "Polygon"; coordinates: Ring[] };
type MultiPolygonGeom = { type: "MultiPolygon"; coordinates: Ring[][] };
type Geom = PolygonGeom | MultiPolygonGeom;

export interface GeofabrikRegion {
  /** Hierarchical slug, e.g. "europe/germany/bayern". */
  id: string;
  /** Human-readable name, e.g. "Bayern". */
  name: string;
  /** Parent slug, e.g. "europe/germany". null for top-level regions. */
  parent: string | null;
  /** Direct URL to the .osm.pbf extract. */
  pbfUrl: string;
  /** Bounding box [minLon, minLat, maxLon, maxLat]. */
  bbox: [number, number, number, number];
  /** Polygon(s) covering the region — used for the point-in-polygon test. */
  geometry: Geom;
}

export interface GeofabrikIndex {
  regions: GeofabrikRegion[];
  fetchedAt: Date;
}

export interface LoadOptions {
  /** Override the index URL (defaults to the official Geofabrik endpoint). */
  url?: string;
  /** Where to persist the cached JSON. Defaults to `data/osm/geofabrik-index.json`. */
  cachePath?: string;
  /** How long to consider a cached copy fresh (ms). Defaults to 7 days. */
  cacheTtlMs?: number;
  /** Test seam — defaults to global `fetch`. */
  fetcher?: typeof fetch;
  /** Test seam — current time. */
  now?: () => Date;
}

const DEFAULT_URL = "https://download.geofabrik.de/index-v1.json";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_PATH = "data/osm/geofabrik-index.json";

/**
 * Load the Geofabrik index, preferring a fresh cached copy if one
 * exists and is younger than `cacheTtlMs`. Falls back to the cached
 * copy on network failure so POI detection keeps working offline.
 */
export async function loadGeofabrikIndex(
  opts: LoadOptions = {},
): Promise<GeofabrikIndex> {
  const url = opts.url ?? DEFAULT_URL;
  const cachePath = opts.cachePath ?? DEFAULT_CACHE_PATH;
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  const fetcher = opts.fetcher ?? fetch;
  const now = opts.now ?? (() => new Date());

  const cached = await readCache(cachePath);
  if (cached && now().getTime() - cached.fetchedAt.getTime() < ttlMs) {
    return cached;
  }

  try {
    const res = await fetcher(url);
    if (!res.ok) {
      throw new Error(`Geofabrik index fetch failed: HTTP ${res.status}`);
    }
    const raw = await res.text();
    const index = parseIndex(raw, now());
    await writeCache(cachePath, raw, index.fetchedAt);
    return index;
  } catch (err) {
    if (cached) {
      console.warn(
        `[osm-admin] geofabrik fetch failed, using cached copy from ` +
          `${cached.fetchedAt.toISOString()}:`,
        err,
      );
      return cached;
    }
    throw err;
  }
}

async function readCache(cachePath: string): Promise<GeofabrikIndex | null> {
  try {
    const buf = await readFile(cachePath, "utf-8");
    const st = await stat(cachePath);
    return parseIndex(buf, st.mtime);
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, raw: string, _fetchedAt: Date): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, raw, "utf-8");
}

/**
 * Parse the Geofabrik index JSON into our typed shape. Defensive against
 * features that lack the fields we need; those get skipped silently.
 */
export function parseIndex(raw: string, fetchedAt: Date): GeofabrikIndex {
  const json = JSON.parse(raw) as { features?: unknown };
  const features = Array.isArray(json.features) ? json.features : [];
  const regions: GeofabrikRegion[] = [];

  for (const f of features) {
    const feat = f as {
      properties?: Record<string, unknown>;
      geometry?: Geom;
    };
    const p = feat.properties ?? {};
    const id = typeof p.id === "string" ? p.id : null;
    const name = typeof p.name === "string" ? p.name : id;
    const urls = (p.urls as Record<string, unknown> | undefined) ?? {};
    const pbfUrl = typeof urls.pbf === "string" ? urls.pbf : null;
    const parent = typeof p.parent === "string" ? p.parent : null;
    const geom = feat.geometry;

    if (!id || !name || !pbfUrl || !geom) continue;
    if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") continue;

    regions.push({
      id,
      name,
      parent,
      pbfUrl,
      bbox: computeBbox(geom),
      geometry: geom,
    });
  }

  return { regions, fetchedAt };
}

function computeBbox(geom: Geom): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const rings = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Standard ray-casting point-in-polygon test. Handles polygons with
 * holes (subsequent rings) and multi-polygons. Coordinates are GeoJSON
 * order [lon, lat].
 */
export function pointInPolygon(lat: number, lon: number, geom: Geom): boolean {
  if (geom.type === "Polygon") return pointInRings(lat, lon, geom.coordinates);
  for (const poly of geom.coordinates) {
    if (pointInRings(lat, lon, poly)) return true;
  }
  return false;
}

function pointInRings(lat: number, lon: number, rings: Ring[]): boolean {
  if (rings.length === 0) return false;
  if (!pointInRing(lat, lon, rings[0])) return false;
  // Subsequent rings are holes — being inside one disqualifies the point.
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lat, lon, rings[i])) return false;
  }
  return true;
}

function pointInRing(lat: number, lon: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function bboxContains(
  bbox: [number, number, number, number],
  lat: number,
  lon: number,
): boolean {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

function bboxAreaDeg(bbox: [number, number, number, number]): number {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return (maxLon - minLon) * (maxLat - minLat);
}

/**
 * Pick the smallest (most specific) Geofabrik region whose polygon
 * contains `(lat, lon)`. "Smallest" is defined hierarchically: a region
 * is preferred over its ancestors. Among siblings the bbox area
 * tie-breaks.
 *
 * Returns null when the point is outside every region's polygon
 * (typical for international waters or non-OSM-covered areas).
 */
export function pickSmallestMatchingRegion(
  index: GeofabrikIndex,
  lat: number,
  lon: number,
): GeofabrikRegion | null {
  const candidates: GeofabrikRegion[] = [];
  for (const r of index.regions) {
    if (!bboxContains(r.bbox, lat, lon)) continue;
    if (!pointInPolygon(lat, lon, r.geometry)) continue;
    candidates.push(r);
  }
  if (candidates.length === 0) return null;

  // Prefer regions whose id is not the parent of any other candidate.
  const parents = new Set(candidates.map((r) => r.parent).filter((p): p is string => !!p));
  const leaves = candidates.filter((r) => !parents.has(r.id));
  const pool = leaves.length > 0 ? leaves : candidates;

  return pool.reduce((best, r) =>
    bboxAreaDeg(r.bbox) < bboxAreaDeg(best.bbox) ? r : best,
  );
}
