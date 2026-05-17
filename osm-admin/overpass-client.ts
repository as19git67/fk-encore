/**
 * Overpass POI candidate lookup against the per-region Overpass shard.
 *
 * Given a photo's GPS, this module:
 *   1. Picks the right regional Overpass via `region-router`.
 *   2. Constructs an Overpass-QL `nwr(around:R)` query with the POI
 *      tag whitelist from `poi.config`.
 *   3. Parses the JSON response into typed candidate records.
 *
 * The query is built from `POI_TAG_FILTERS` so the operator can shift
 * the whitelist without touching this file. Each candidate carries
 * its OSM ref, computed crow-flies distance, primary tag, name(s),
 * and (when present) the `wikidata` and `wikipedia` tag values so the
 * Wikidata enrichment step (Etappe 4b) can dedupe.
 */

import { POI_MAX_CANDIDATES, POI_RADIUS_M, POI_TAG_FILTERS } from "./poi.config";

export interface OverpassCandidate {
  osmRef: string; // node:123, way:456, relation:789
  type: "node" | "way" | "relation";
  id: number;
  lat: number;
  lon: number;
  /** Crow-flies distance in meters from the query point. */
  distanceM: number;
  name: string | null;
  nameDe: string | null;
  /** Primary classification: "tourism=attraction", "historic=ruins", … */
  primaryTag: string | null;
  /** Raw `wikidata` tag (e.g. `Q5074`). Empty when not tagged. */
  wikidataQid: string | null;
  /** Raw `wikipedia` tag (e.g. `de:Marienplatz`). */
  wikipedia: string | null;
}

export interface OverpassFetchDeps {
  /** Override fetch for tests. */
  fetcher?: typeof fetch;
}

export interface OverpassResult {
  /** Raw candidates, sorted by distance ascending. */
  candidates: OverpassCandidate[];
  /** OQL body that was executed — exported for diagnostics. */
  query: string;
}

/**
 * Build the Overpass-QL body for a `(lat, lon, radius)` POI scan. The
 * resulting query asks for nodes + ways + relations matching any of
 * the configured tag filters, with `out center` so ways/relations
 * collapse to a single representative coordinate.
 */
export function buildPoiOverpassQuery(
  lat: number,
  lon: number,
  radiusM: number = POI_RADIUS_M,
): string {
  const radius = Math.max(1, Math.round(radiusM));
  const filters = POI_TAG_FILTERS.map((f) => {
    if (f.values === "*") return `["${f.key}"]`;
    const escaped = f.values.map((v) => v.replace(/"/g, "\\\"")).join("|");
    return `["${f.key}"~"^(${escaped})$"]`;
  });
  // Union of nwr filters; `out center` gives ways/relations a single
  // coordinate for distance computation.
  const lines: string[] = ["[out:json][timeout:25];", "("];
  for (const f of filters) {
    lines.push(`  nwr${f}(around:${radius},${lat.toFixed(6)},${lon.toFixed(6)});`);
  }
  lines.push(");", "out tags center;");
  return lines.join("\n");
}

/**
 * Run an Overpass POI scan against `endpoint` (typically
 * `http://overpass-<slug>/api/interpreter`).
 */
export async function fetchPoiCandidates(
  endpoint: string,
  lat: number,
  lon: number,
  opts: { radiusM?: number; maxCandidates?: number } & OverpassFetchDeps = {},
): Promise<OverpassResult> {
  const fetcher = opts.fetcher ?? fetch;
  const radius = opts.radiusM ?? POI_RADIUS_M;
  const maxCandidates = opts.maxCandidates ?? POI_MAX_CANDIDATES;
  const query = buildPoiOverpassQuery(lat, lon, radius);

  const res = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "User-Agent": "fk-encore-osm-admin/1.0",
    },
    body: query,
  });
  if (!res.ok) {
    throw new Error(`overpass ${endpoint}: HTTP ${res.status}`);
  }
  const body = (await res.json()) as OverpassRawResponse;
  return {
    candidates: parseOverpassResponse(body, lat, lon, maxCandidates),
    query,
  };
}

interface OverpassRawElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassRawResponse {
  elements?: OverpassRawElement[];
}

/**
 * Convert Overpass JSON to typed candidates, computing crow-flies
 * distance against the query point and dropping any element that
 * lacks coordinates (defensive — should not happen with `out center`).
 */
export function parseOverpassResponse(
  body: OverpassRawResponse,
  queryLat: number,
  queryLon: number,
  maxCandidates: number,
): OverpassCandidate[] {
  const elements = Array.isArray(body.elements) ? body.elements : [];
  const out: OverpassCandidate[] = [];
  for (const el of elements) {
    const coord = el.type === "node"
      ? (typeof el.lat === "number" && typeof el.lon === "number" ? { lat: el.lat, lon: el.lon } : null)
      : el.center ?? null;
    if (!coord) continue;
    const tags = el.tags ?? {};
    out.push({
      osmRef: `${el.type}:${el.id}`,
      type: el.type,
      id: el.id,
      lat: coord.lat,
      lon: coord.lon,
      distanceM: crowFliesMeters(queryLat, queryLon, coord.lat, coord.lon),
      name: tags.name ?? null,
      nameDe: tags["name:de"] ?? null,
      primaryTag: primaryTagFor(tags),
      wikidataQid: tags.wikidata ?? null,
      wikipedia: tags.wikipedia ?? null,
    });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out.slice(0, maxCandidates);
}

/**
 * Determine which whitelist tag this element actually matched. We try
 * each filter in declaration order and return the first hit; this
 * gives deterministic results when an element carries e.g. both
 * `tourism=museum` and `historic=fort`.
 */
function primaryTagFor(tags: Record<string, string>): string | null {
  for (const f of POI_TAG_FILTERS) {
    const v = tags[f.key];
    if (v === undefined) continue;
    if (f.values === "*") return `${f.key}=${v}`;
    if (f.values.includes(v)) return `${f.key}=${v}`;
  }
  return null;
}

/**
 * Equirectangular projection — accurate to within a few percent for
 * the POI radii we use (≤ 200 m). No need for haversine here.
 */
export function crowFliesMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371008.8; // mean Earth radius (m)
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.sqrt(x * x + y * y) * R;
}
