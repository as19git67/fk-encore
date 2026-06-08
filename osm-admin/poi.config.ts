/**
 * Tunable parameters for the POI detection pipeline (Epic #383).
 *
 * Everything here is per-process configuration the operator might
 * conceivably want to tweak without rebuilding. Defaults are chosen
 * for the typical European family-photo use case.
 */

/** Radius (m) around a photo's GPS to scan for POI candidates. */
export const POI_RADIUS_M = parseIntEnv("POI_DETECTION_RADIUS_M", 200);

/** Maximum number of POI candidates kept per photo before scoring. */
export const POI_MAX_CANDIDATES = parseIntEnv("POI_DETECTION_MAX_CANDIDATES", 25);

/** Score margin between top-1 and top-2 needed to declare an unambiguous winner. */
export const POI_AMBIGUITY_MARGIN = parseFloatEnv("POI_MATCH_AMBIGUITY_MARGIN", 0.05);

/** Minimum match score required to persist a match at all (top-1). */
export const POI_MIN_MATCH_SCORE = parseFloatEnv("POI_MATCH_MIN_SCORE", 0.55);

/**
 * Hard image-similarity gate: the minimum RAW cosine similarity
 * (photo embedding vs. POI reference embedding, in [-1, 1]) a candidate
 * must reach to be eligible at all.
 *
 * Without this gate, proximity (0.2 weight) plus the heading fallback
 * (0.2 · 0.5) plus the inflated similarity floor — the composite score
 * remaps raw cosine [-1,1] → [0,1], so an unrelated image still scores
 * ~0.7 there — let a POI clear `POI_MIN_MATCH_SCORE` on geography alone,
 * even when its reference picture looks nothing like the photo. The gate
 * is applied to the *raw* cosine before any remapping, so it directly
 * reflects visual resemblance. Candidates below it are dropped before
 * scoring entirely. Lower it (e.g. 0.45) if true matches with strong
 * viewpoint/lighting differences start getting rejected.
 */
export const POI_MIN_SIMILARITY = parseFloatEnv("POI_MATCH_MIN_SIMILARITY", 0.5);

/**
 * OSM tag filters consumed by the geo service's `/pois` endpoint. The
 * set is chosen to cover what humans typically photograph as a
 * "Sehenswürdigkeit" without dragging in every road sign or bench.
 *
 * Must stay in sync with the matches_poi() table in
 * geo/src/osm2pgsql.lua — the Lua filter decides at import time which
 * OSM elements end up in `osm_pois`, and this list decides at query
 * time which of those qualify as candidates.
 */
export interface PoiTagFilter {
  /** OSM key, e.g. `tourism`. */
  key: string;
  /** OR-list of acceptable values, or `"*"` to match any value. */
  values: readonly string[] | "*";
}

export const POI_TAG_FILTERS: readonly PoiTagFilter[] = [
  {
    key: "tourism",
    values: ["attraction", "museum", "artwork", "viewpoint", "gallery", "monument"],
  },
  // historic=* is broad but consistent — every historic value
  // corresponds to something that people photograph (memorial,
  // castle, archaeological_site, ruins, …).
  { key: "historic", values: "*" },
  { key: "amenity", values: ["place_of_worship", "theatre"] },
  {
    key: "building",
    values: ["castle", "cathedral", "church", "monastery", "palace"],
  },
  {
    key: "man_made",
    values: ["tower", "lighthouse", "bridge", "obelisk"],
  },
];

function parseIntEnv(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function parseFloatEnv(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}
