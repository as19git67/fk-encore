/**
 * What a place name means beyond its spelling, for "Fotos aus <Land>".
 *
 * A photo's place is written by whoever geocoded it: public Nominatim
 * answers in German, the local geo service with the OSM `name` tag, which
 * is the native one (often in another script), and a camera's
 * IPTC block in whatever language the app used. A substring match on the
 * term the user typed misses most of that, and a large city is often
 * not in any stored field at all (the wards are what the local admin
 * boundaries name). So the term is forward-geocoded once: its names in the
 * other languages widen the text match, and its outline lets photos match
 * by coordinates.
 */

/** [south, north, west, east] in degrees, as Nominatim's `boundingbox`. */
export type BBox = [number, number, number, number];

/** GeoJSON coordinates of one polygon: outer ring first, then holes. */
type PolygonRings = number[][][];

export interface ResolvedPlace {
  /** Other spellings of the place, the term itself not included. */
  names: string[];
  /** Box to pre-select candidates by coordinates; absent when only names fit. */
  bbox?: BBox;
  /** The outline; absent for a place Nominatim knows only as a point. */
  polygons?: PolygonRings[];
}

interface NominatimSearchHit {
  category?: string;
  type?: string;
  addresstype?: string;
  boundingbox?: string[];
  namedetails?: Record<string, string>;
  geojson?: { type: string; coordinates: unknown };
}

/** Name tags taken as spellings; the rest (`name:xx` of every language) would match too much. */
const NAME_KEYS = ["name", "name:de", "name:en", "int_name", "official_name", "official_name:de", "official_name:en", "short_name", "short_name:de", "short_name:en"];

/** A box this coarse cannot stand in for an outline: it covers neighbouring countries too. */
const BOX_ONLY_TOO_COARSE = new Set(["country", "state", "region", "province"]);

/**
 * The place a Nominatim search answered with, as names and area. Only the
 * best hit counts: the next ones are other places sharing the name.
 * Exported for unit tests.
 */
export function placeFromHit(hit: NominatimSearchHit | undefined, term: string): ResolvedPlace | null {
  if (!hit) return null;
  if (hit.category !== "boundary" && hit.category !== "place") return null;
  const lower = term.toLocaleLowerCase("de");
  const names = [...new Set(
    NAME_KEYS.map((k) => hit.namedetails?.[k]?.trim())
      .filter((v): v is string => !!v && v.length >= 2 && v.length <= 100 && v.toLocaleLowerCase("de") !== lower),
  )];
  const place: ResolvedPlace = { names };

  const polygons = polygonsOf(hit.geojson);
  const bb = hit.boundingbox?.map(Number);
  const bbox = bb && bb.length === 4 && bb.every(Number.isFinite) ? (bb as BBox) : undefined;
  if (polygons.length) {
    place.polygons = polygons;
    place.bbox = bbox ?? bboxOf(polygons);
  } else if (bbox && !BOX_ONLY_TOO_COARSE.has(hit.addresstype ?? hit.type ?? "")) {
    place.bbox = bbox;
  }
  return place;
}

function polygonsOf(geojson: NominatimSearchHit["geojson"]): PolygonRings[] {
  if (!geojson || !Array.isArray(geojson.coordinates)) return [];
  if (geojson.type === "Polygon") return [geojson.coordinates as PolygonRings];
  if (geojson.type === "MultiPolygon") return geojson.coordinates as PolygonRings[];
  return [];
}

function bboxOf(polygons: PolygonRings[]): BBox {
  let s = 90, n = -90, w = 180, e = -180;
  for (const poly of polygons) {
    for (const [lon, lat] of poly[0] ?? []) {
      if (lat < s) s = lat; if (lat > n) n = lat;
      if (lon < w) w = lon; if (lon > e) e = lon;
    }
  }
  return [s, n, w, e];
}

/** Even-odd ray casting over one ring of [lon, lat] points. */
function inRing(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether a point lies in the place: in its outline if it has one, else in its box. Exported for unit tests. */
export function placeContains(place: ResolvedPlace, lat: number, lon: number): boolean {
  if (place.polygons) {
    return place.polygons.some((rings) =>
      rings.length > 0 && inRing(lat, lon, rings[0]) && !rings.slice(1).some((hole) => inRing(lat, lon, hole)));
  }
  if (!place.bbox) return false;
  const [s, n, w, e] = place.bbox;
  return lat >= s && lat <= n && lon >= w && lon <= e;
}

// Public Nominatim allows one request per second; the gallery's location
// autocomplete shares this queue (photo.service.ts).
let tail: Promise<void> = Promise.resolve();
let lastAt = 0;

/** One Nominatim `/search` call, queued at one per second. Null on any failure. */
export async function nominatimSearch(params: Record<string, string>): Promise<unknown[] | null> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const waitMs = Math.max(0, 1_000 - (Date.now() - lastAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastAt = Date.now();
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams(params)}`, {
      headers: { "User-Agent": "fk-encore-photo-app/1.0" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.warn("Nominatim search failed:", (err as Error).message ?? err);
    return null;
  } finally {
    release();
  }
}

const cache = new Map<string, { expiresAt: number; place: ResolvedPlace | null }>();
const CACHE_SIZE = 50;
const CACHE_TTL_MS = 24 * 60 * 60_000;
/** A failed lookup is retried sooner than a known answer. */
const FAILURE_TTL_MS = 5 * 60_000;

/**
 * Names and area of a place term, or null when Nominatim does not know it
 * or cannot be reached — the caller then matches the term alone, as before.
 */
export async function resolvePlace(term: string): Promise<ResolvedPlace | null> {
  const normalized = term.trim().replace(/\s+/g, " ");
  if (normalized.length < 2) return null;
  const key = normalized.toLocaleLowerCase("de");
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.place;

  const data = await nominatimSearch({
    q: normalized,
    format: "jsonv2",
    limit: "1",
    namedetails: "1",
    polygon_geojson: "1",
    // About a kilometre: enough for "which country, which city", and a
    // country's outline stays a few thousand points.
    polygon_threshold: "0.01",
    "accept-language": "de,en",
  });
  const place = data ? placeFromHit(data[0] as NominatimSearchHit | undefined, normalized) : null;
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, { expiresAt: Date.now() + (data ? CACHE_TTL_MS : FAILURE_TTL_MS), place });
  return place;
}
