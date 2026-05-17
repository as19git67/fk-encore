/**
 * Tunable parameters for the POI detection pipeline (Epic #383).
 *
 * Everything here is per-process configuration the operator might
 * conceivably want to tweak without rebuilding. Defaults are chosen
 * for the typical European family-photo use case.
 */

/** Radius (m) around a photo's GPS to scan for POI candidates. */
export const POI_RADIUS_M = parseIntEnv("POI_DETECTION_RADIUS_M", 200);

/** Maximum number of Overpass candidates kept per photo before scoring. */
export const POI_MAX_CANDIDATES = parseIntEnv("POI_DETECTION_MAX_CANDIDATES", 25);

/** Score margin between top-1 and top-2 needed to declare an unambiguous winner. */
export const POI_AMBIGUITY_MARGIN = parseFloatEnv("POI_MATCH_AMBIGUITY_MARGIN", 0.05);

/** Minimum match score required to persist a match at all (top-1). */
export const POI_MIN_MATCH_SCORE = parseFloatEnv("POI_MATCH_MIN_SCORE", 0.55);

/**
 * OSM tag filters used in the Overpass radius query. The combined
 * filter is `nwr(around:R, lat, lon)[tag~"value-pattern"]`. The set
 * is chosen to cover what humans typically photograph as a
 * "Sehenswürdigkeit" without dragging in every road sign or bench.
 *
 * Each entry produces a separate `nwr[...]` clause inside a single
 * Overpass union — the union's deduplication picks the right element
 * when the same node carries multiple tag families.
 */
export interface OverpassTagFilter {
  /** OSM key, e.g. `tourism`. */
  key: string;
  /** OR-list of acceptable values, or `"*"` to match any value. */
  values: readonly string[] | "*";
}

export const POI_TAG_FILTERS: readonly OverpassTagFilter[] = [
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
