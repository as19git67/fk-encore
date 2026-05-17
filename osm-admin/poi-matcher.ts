/**
 * POI matcher (Epic #383).
 *
 * Given a photo (with GPS + DINOv2 embedding) and a list of candidate
 * POIs (with their own DINOv2 embedding via poi_references), this
 * module:
 *
 *   1. Computes a composite score per candidate
 *      = 0.6 · (1 - cosine_distance(photo, poi))
 *      + 0.2 · heading_match
 *      + 0.2 · proximity_factor(distance_m)
 *   2. Picks the top-1 if it leads top-2 by `POI_AMBIGUITY_MARGIN` and
 *      meets `POI_MIN_MATCH_SCORE`.
 *   3. Otherwise marks all top candidates as `ambiguous=true` so the
 *      UI shows them as alternatives.
 *
 * The function is pure — no DB writes here. Persistence lives in
 * `persistPoiMatches` (next step) so the matcher can be unit-tested
 * with synthetic inputs.
 */

import { POI_AMBIGUITY_MARGIN, POI_MIN_MATCH_SCORE } from "./poi.config";

export interface MatchCandidate {
  qid: string | null;
  osmRef: string;
  name: string;
  nameDe: string | null;
  /** Centroid coordinates from Overpass (`out tags center`). */
  lat: number;
  lon: number;
  distanceM: number;
  /** DINOv2 vector for the POI reference image. Length must match `photoEmbedding`. */
  poiEmbedding: number[] | null;
  source: "osm" | "wikidata" | "both";
  regionSlug?: string;
}

export interface MatchInput {
  /** Photo's DINOv2 vector (length 768 for facebook/dinov2-base). */
  photoEmbedding: number[];
  /** Photo's compass heading from EXIF (`GPSImgDirection`), 0–360°. */
  photoHeadingDeg: number | null;
  /** Photo's GPS — used to compute the bearing to each candidate. */
  photoLat: number;
  photoLon: number;
  candidates: MatchCandidate[];
}

export interface ScoredMatch {
  qid: string | null;
  osmRef: string;
  name: string;
  nameDe: string | null;
  distanceM: number;
  headingMatch: number | null;
  matchScore: number;
  ambiguous: boolean;
  source: "osm" | "wikidata" | "both";
  regionSlug: string | null;
}

export interface MatchResult {
  /** Top-1 first; if `ambiguous` is true on row 0, top-2/3 follow. */
  matches: ScoredMatch[];
  /** Why the matcher produced nothing useful, when matches is empty. */
  reason?: string;
}

export function matchPhotoToPois(input: MatchInput): MatchResult {
  if (input.candidates.length === 0) {
    return { matches: [], reason: "no_candidates" };
  }
  if (input.photoEmbedding.length === 0) {
    return { matches: [], reason: "no_photo_embedding" };
  }

  const scored: ScoredMatch[] = [];
  for (const c of input.candidates) {
    if (!c.poiEmbedding || c.poiEmbedding.length === 0) continue;
    if (c.poiEmbedding.length !== input.photoEmbedding.length) continue;

    const similarity = cosineSimilarity(input.photoEmbedding, c.poiEmbedding);
    const bearing = bearingDeg(input.photoLat, input.photoLon, c.lat, c.lon);
    const heading = computeHeadingMatch(input.photoHeadingDeg, bearing);
    const proximity = proximityFactor(c.distanceM);
    const score = 0.6 * similarity + 0.2 * (heading ?? 0.5) + 0.2 * proximity;

    scored.push({
      qid: c.qid,
      osmRef: c.osmRef,
      name: c.name,
      nameDe: c.nameDe,
      distanceM: c.distanceM,
      headingMatch: heading,
      matchScore: score,
      ambiguous: false,
      source: c.source,
      regionSlug: c.regionSlug ?? null,
    });
  }

  if (scored.length === 0) {
    return { matches: [], reason: "no_embeddings_for_candidates" };
  }

  scored.sort((a, b) => b.matchScore - a.matchScore);
  const top = scored[0];
  if (top.matchScore < POI_MIN_MATCH_SCORE) {
    return { matches: [], reason: "below_threshold" };
  }

  const margin = scored[1] ? top.matchScore - scored[1].matchScore : Infinity;
  if (margin < POI_AMBIGUITY_MARGIN) {
    // Top-1 ties with top-2 within the margin → keep up to 3 with
    // ambiguous=true so the UI shows alternatives.
    return {
      matches: scored.slice(0, 3).map((m) => ({ ...m, ambiguous: true })),
    };
  }
  return { matches: [top] };
}

/**
 * Cosine similarity in [-1, 1]. We clamp it into [0, 1] before
 * folding into the score; pgvector vectors are typically unit-norm
 * already which puts most similarities in [0.4, 1.0].
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const raw = dot / Math.sqrt(na * nb);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, (raw + 1) / 2));
}

/**
 * Proximity weight: 1 at the POI centroid, 0.5 at 50 m, → 0 in the
 * far-field. Function: 1 / (1 + d/50). This dampens the influence of
 * distance once you're inside the radius the Overpass query already
 * filtered by, but still discriminates against the 200 m edge.
 */
export function proximityFactor(distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM < 0) return 0;
  return 1 / (1 + distanceM / 50);
}

/**
 * Heading agreement, [0, 1]. 1 when the photo's compass heading
 * matches the bearing to the POI; 0 when they're 180° apart. Null
 * pass-through when the photo doesn't carry an EXIF heading.
 */
export function computeHeadingMatch(
  photoHeadingDeg: number | null,
  bearingToPoi: number,
): number | null {
  if (photoHeadingDeg === null || !Number.isFinite(photoHeadingDeg)) return null;
  const diff = Math.abs(angularDelta(photoHeadingDeg, bearingToPoi));
  // Linear: 0° → 1.0, 90° → 0.5, 180° → 0.
  return Math.max(0, 1 - diff / 180);
}

/** Difference between two angles in [0, 180]. */
function angularDelta(a: number, b: number): number {
  let d = ((a - b) % 360 + 360) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Initial bearing (compass heading 0–360°) from photo to POI.
 * Standard great-circle formula — exact enough for ≤ 200 m radii too.
 */
export function bearingDeg(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): number {
  const rad = Math.PI / 180;
  const φ1 = fromLat * rad;
  const φ2 = toLat * rad;
  const Δλ = (toLon - fromLon) * rad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}
