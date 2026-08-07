/**
 * Per-group "best of group" scoring for the similar-photo auto-pick
 * feature (Track I, see issue #358 / #346).
 *
 * Pure logic. All inputs are passed in by photo.service.ts after a
 * single SQL aggregation; this module never touches the DB so the math
 * stays trivially unit-testable.
 *
 * Score is a linear combination of the signals already computed by the
 * embedding service and stored in photos.ai_quality_details, branched
 * by whether the photo contains any detected faces:
 *
 *   With face:
 *     0.45 · face_sharpness
 *   + 0.20 · eyes_open
 *   + 0.15 · face_coverage          (NEW: Σ bbox_area / 1.0)
 *   + 0.10 · blur
 *   + 0.05 · clip_aesthetics
 *   + 0.05 · 0.5·(exposure + contrast)
 *
 *   Without face:
 *     0.40 · blur
 *   + 0.25 · clip_aesthetics
 *   + 0.15 · clip_composition
 *   + 0.10 · clip_technical
 *   + 0.10 · 0.5·(exposure + contrast)
 *
 * Multi-pick: Top-1 always picks. Plus any photo with
 *   score ≥ MULTI_PICK_THRESHOLD · top_score    (default 0.92)
 *
 * Redundancy: a multi-pick that merely repeats a better pick (DINOv2 cosine
 *   ≥ REDUNDANCY_SIMILARITY, same orientation) is dropped again, and its slot
 *   offered to the best visually different sibling scoring ≥ DIVERSITY_FLOOR ·
 *   top_score. Without this the pick set keeps two frames of the same burst,
 *   because near-identical frames also score near-identically.
 *
 * Confidence gate (drives the gallery auto-hide behaviour):
 *   Δ = top_score − best_non_pick_score
 *   Δ ≥ HIGH_CONFIDENCE_DELTA (0.10) → "high"   — auto-hide non-picks
 *   Δ ≥ MEDIUM_CONFIDENCE_DELTA (0.04) → "medium" — prominent marker, no hide
 *   else                                   → "low"   — today's review workflow
 */

import type { AiPickDetails, AiPickPhotoScore } from "../db/schema";

export const MULTI_PICK_THRESHOLD = 0.92;
export const HIGH_CONFIDENCE_DELTA = 0.10;
export const MEDIUM_CONFIDENCE_DELTA = 0.04;
/**
 * When a similar group contains photos of different orientations
 * (portrait + landscape of the same subject — typical for "I took
 * both because either could be the keeper depending on what device
 * I look at it on later"), promote the best photo of each present
 * orientation to the multi-pick set, provided its score is at least
 * this fraction of the top score.
 *
 * 0.75 lets a clearly inferior orientation lose, but keeps the
 * "second orientation, mildly worse" case both selected. Square
 * photos are excluded from the rule entirely — a single
 * near-square outlier in a portrait burst should not steal a slot.
 */
export const ORIENTATION_FLOOR = 0.75;

/**
 * Two members of a group count as *redundant* — the same shot twice — from
 * this DINOv2 cosine similarity upward. Every member of a similar group is
 * similar to every other one by construction (that is why they were grouped,
 * see SIMILARITY_THRESHOLD in photo.service.ts), so this sits far above the
 * grouping threshold and below DUPLICATE_VISUAL_THRESHOLD (0.995), which
 * describes byte-level duplicates rather than "one more frame of the burst".
 *
 * Computed by the embedding service (`POST /redundant-pairs`) and passed in;
 * this module stays pure.
 */
export const REDUNDANCY_SIMILARITY = 0.97;

/**
 * A photo promoted into the pick set *because* a redundant sibling was
 * dropped must still be worth keeping. It has to reach this fraction of the
 * top score — looser than MULTI_PICK_THRESHOLD (0.92), because the whole point
 * is to accept a slightly weaker photo in exchange for it showing something
 * different, but not so loose that a clearly bad frame gets promoted.
 */
export const DIVERSITY_FLOOR = 0.85;

export type Orientation = "portrait" | "landscape" | "square";

export function classifyOrientation(width: number | null | undefined, height: number | null | undefined): Orientation {
  // Pre-backfill default: assume landscape so the diversity rule
  // degenerates to a no-op (orientations.size === 1) until dimensions
  // are populated. Safe — no spurious picks while the backfill runs.
  if (!width || !height || width <= 0 || height <= 0) return "landscape";
  const ratio = width / height;
  if (ratio > 1.1) return "landscape";
  if (ratio < 0.9) return "portrait";
  return "square";
}

/** Quality signals for one photo as stored in photos.ai_quality_details. */
export interface PhotoSignals {
  photo_id: number;
  // From photos.ai_quality_details — all in [0, 1] when populated.
  blur_score?: number | null;
  contrast_score?: number | null;
  exposure_score?: number | null;
  clip_aesthetics?: number | null;
  clip_composition?: number | null;
  clip_technical?: number | null;
  face_sharpness?: number | null;
  eyes_open_score?: number | null;
  /**
   * Face-composition score produced by the embedding service (e.g.
   * eye line alignment, rule-of-thirds positioning of the dominant
   * face). Range [0, 1]; missing on photos without a detected face.
   */
  face_composition?: number | null;
  // Derived from faces table:
  //   face_count    = number of detected faces
  //   face_coverage = Σ (bbox.width · bbox.height), normalised relative to
  //                   the full image (bbox coords are already 0..1).
  face_count: number;
  face_coverage: number;
  // Photo orientation post-EXIF-rotation. Drives the orientation
  // diversity rule in computeGroupPick — see ORIENTATION_FLOOR.
  // Defaults to "landscape" when dimensions are still NULL (backfill
  // pending), so the rule no-ops until data is available.
  orientation?: Orientation;
}

export type AiConfidence = "high" | "medium" | "low";

/**
 * One near-identical member pair as reported by the embedding service.
 * Order of the two ids carries no meaning.
 */
export interface RedundantPair {
  photo_id_a: number;
  photo_id_b: number;
  similarity: number;
}

/**
 * Symmetric lookup over the reported pairs. Photos without an embedding
 * appear in no pair at all, so a missing vector can never cause a photo to be
 * dropped — the rule only ever acts on positive evidence of redundancy.
 */
function buildRedundancyIndex(pairs: RedundantPair[]): Map<number, Set<number>> {
  const index = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    const set = index.get(a);
    if (set) set.add(b);
    else index.set(a, new Set([b]));
  };
  for (const pair of pairs) {
    if (pair.photo_id_a === pair.photo_id_b) continue;
    link(pair.photo_id_a, pair.photo_id_b);
    link(pair.photo_id_b, pair.photo_id_a);
  }
  return index;
}

export interface AiPickResult {
  picked_photo_ids: number[];
  confidence: AiConfidence;
  details: AiPickDetails;
}

/**
 * Clamp a possibly-null/undefined value to [0, 1]. Missing signals fall
 * back to a neutral 0.5 so a photo that has not been fully scored is
 * neither punished nor rewarded relative to the rest of the group.
 */
function clamp01(value: number | null | undefined, fallback = 0.5): number {
  if (value == null || Number.isNaN(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Face-coverage rewards prominent faces but saturates above ~30% of the
 * frame — beyond that the photo is a close-up and additional area gives
 * diminishing returns. Normalised to [0, 1].
 */
function normaliseFaceCoverage(coverage: number): number {
  const SATURATION = 0.30;
  if (coverage <= 0) return 0;
  if (coverage >= SATURATION) return 1;
  return coverage / SATURATION;
}

/**
 * Per-branch weight vectors. Order MUST match the signal access
 * inside scorePhoto() and the calibration features in
 * group-auto-pick.calibration.ts (faceFeatures / nonFaceFeatures).
 */
export interface ScoringWeights {
  face: number[];     // [face_sharpness, eyes_open, face_coverage,
                      //  face_composition, blur, clip_aesthetics,
                      //  exposure_contrast_avg]
  non_face: number[]; // [blur, clip_aesthetics, clip_composition,
                      //  clip_technical, exposure_contrast_avg]
}

/**
 * Defaults — tuned 2026-05 from the first calibration export.
 *   Face: face_sharpness stays dominant (clear bimodal signal in the
 *   sample); face_composition (0.10) was added once the embedding
 *   service exposed it; blur (= global sharpness) dropped to 0.05
 *   because on this library it sits near 1.0 across the board.
 */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  face:     [0.40, 0.20, 0.15, 0.10, 0.05, 0.05, 0.05],
  non_face: [0.40, 0.25, 0.15, 0.10, 0.10],
};

/**
 * Compute the per-photo score and its sub-signal breakdown.
 *
 * `weights` lets the caller override the default vectors (used for
 * per-user calibration — see group-auto-pick.calibration.ts). When
 * absent, falls back to DEFAULT_SCORING_WEIGHTS.
 */
export function scorePhoto(
  signals: PhotoSignals,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): AiPickPhotoScore {
  const hasFace = signals.face_count > 0;
  const blur = clamp01(signals.blur_score);
  const contrast = clamp01(signals.contrast_score);
  const exposure = clamp01(signals.exposure_score);
  const aesthetics = clamp01(signals.clip_aesthetics);
  const composition = clamp01(signals.clip_composition);
  const technical = clamp01(signals.clip_technical);
  const exposureContrast = 0.5 * (exposure + contrast);

  let score: number;
  const used: AiPickPhotoScore["signals"] = {};
  if (hasFace) {
    const faceSharpness = clamp01(signals.face_sharpness);
    const eyesOpen = clamp01(signals.eyes_open_score);
    const faceCoverage = normaliseFaceCoverage(signals.face_coverage);
    const faceComposition = clamp01(signals.face_composition);
    const w = weights.face;
    score =
      w[0] * faceSharpness +
      w[1] * eyesOpen +
      w[2] * faceCoverage +
      w[3] * faceComposition +
      w[4] * blur +
      w[5] * aesthetics +
      w[6] * exposureContrast;
    used.face_sharpness = faceSharpness;
    used.eyes_open = eyesOpen;
    used.face_coverage = faceCoverage;
    used.face_composition = faceComposition;
    used.blur = blur;
    used.clip_aesthetics = aesthetics;
    used.contrast = contrast;
    used.exposure = exposure;
  } else {
    const w = weights.non_face;
    score =
      w[0] * blur +
      w[1] * aesthetics +
      w[2] * composition +
      w[3] * technical +
      w[4] * exposureContrast;
    used.blur = blur;
    used.clip_aesthetics = aesthetics;
    used.clip_composition = composition;
    used.clip_technical = technical;
    used.contrast = contrast;
    used.exposure = exposure;
  }

  return {
    photo_id: signals.photo_id,
    score,
    has_face: hasFace,
    ...(signals.orientation ? { orientation: signals.orientation } : {}),
    signals: used,
  };
}

/**
 * Score every photo in a group, then pick the AI best-of-group.
 *
 * Returns picked photo IDs sorted ascending (deterministic; UI ordering
 * is taken_at chronological, not score-based — see issue feedback
 * "Risiko 7"), the confidence bucket, and the full details JSON to be
 * persisted in photo_groups.ai_pick_details.
 *
 * Groups with fewer than 2 photos return an empty pick — they should
 * never be created as similar groups in the first place.
 */
export function computeGroupPick(
  photos: PhotoSignals[],
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
  redundantPairs: RedundantPair[] = [],
): AiPickResult {
  if (photos.length < 2) {
    return {
      picked_photo_ids: photos.map((p) => p.photo_id),
      confidence: "low",
      details: {
        runner_up_delta: 0,
        multi_pick_threshold: MULTI_PICK_THRESHOLD,
        scores: photos.map((p) => scorePhoto(p, weights)),
      },
    };
  }

  const scores = photos.map((p) => scorePhoto(p, weights));
  // Sort by score desc, with photo_id asc as deterministic tie-break so
  // two identically-scored photos pick the lower ID consistently.
  const ranked = [...scores].sort(
    (a, b) => b.score - a.score || a.photo_id - b.photo_id,
  );
  const topScore = ranked[0].score;
  const cutoff = topScore * MULTI_PICK_THRESHOLD;
  const picked = ranked.filter((s) => s.score >= cutoff);
  const pickedIds = new Set(picked.map((p) => p.photo_id));

  // Orientation-diversity rule. When a group contains photos of more
  // than one orientation (portrait + landscape of the same subject),
  // promote the best photo of each orientation already present — as
  // long as it is at least ORIENTATION_FLOOR · topScore. Square photos
  // are excluded so a single near-square outlier in a portrait burst
  // doesn't kidnap a slot. The rule only ever adds to the pick set,
  // never removes, so the confidence gate downstream is unaffected.
  const orientationsInGroup = new Set<Orientation>();
  for (const p of photos) {
    if (p.orientation && p.orientation !== "square") orientationsInGroup.add(p.orientation);
  }
  if (orientationsInGroup.size > 1) {
    const orientationByPhotoId = new Map(
      photos.map((p) => [p.photo_id, p.orientation] as const),
    );
    for (const orientation of orientationsInGroup) {
      const bestOfOrientation = ranked.find(
        (s) => orientationByPhotoId.get(s.photo_id) === orientation,
      );
      if (bestOfOrientation && bestOfOrientation.score >= topScore * ORIENTATION_FLOOR) {
        pickedIds.add(bestOfOrientation.photo_id);
      }
    }
  }

  // Redundancy rule. The multi-pick threshold is a *score* comparison, and
  // two frames of the same burst score near-identically precisely because they
  // show the same thing — so the pick set could end up holding the same moment
  // twice. Walk the picks best-first, drop any that merely repeats a pick
  // already accepted, and give the freed slot to the best sibling that shows
  // something else (if one clears DIVERSITY_FLOOR). Trading a hair of quality
  // for a genuinely different photo is the whole point.
  //
  // Redundancy is only ever judged *within* one orientation: portrait and
  // landscape of the same subject are visually near-identical, but keeping
  // both is a deliberate product decision (see ORIENTATION_FLOOR), so they
  // must never suppress each other.
  const suppressed: number[] = [];
  const promoted: number[] = [];
  if (redundantPairs.length > 0 && pickedIds.size > 1) {
    const redundancy = buildRedundancyIndex(redundantPairs);
    const orientationByPhotoId = new Map(
      photos.map((p) => [p.photo_id, p.orientation ?? "landscape"] as const),
    );
    const repeatsAccepted = (photoId: number, accepted: number[]): boolean => {
      const alike = redundancy.get(photoId);
      if (!alike) return false;
      const orientation = orientationByPhotoId.get(photoId);
      return accepted.some(
        (acceptedId) =>
          alike.has(acceptedId) &&
          orientationByPhotoId.get(acceptedId) === orientation,
      );
    };

    const accepted: number[] = [];
    for (const candidate of ranked) {
      if (!pickedIds.has(candidate.photo_id)) continue;
      // The top-scored photo is never suppressed — there is nothing better
      // for it to be redundant with.
      if (accepted.length === 0 || !repeatsAccepted(candidate.photo_id, accepted)) {
        accepted.push(candidate.photo_id);
      } else {
        suppressed.push(candidate.photo_id);
      }
    }

    // Refill: one replacement per suppressed pick, best-first, and only from
    // photos that are themselves not a repeat of anything already accepted.
    for (let slot = 0; slot < suppressed.length; slot++) {
      const replacement = ranked.find(
        (s) =>
          !accepted.includes(s.photo_id) &&
          !suppressed.includes(s.photo_id) &&
          !promoted.includes(s.photo_id) &&
          s.score >= topScore * DIVERSITY_FLOOR &&
          !repeatsAccepted(s.photo_id, accepted),
      );
      if (!replacement) break;
      accepted.push(replacement.photo_id);
      promoted.push(replacement.photo_id);
    }

    if (suppressed.length > 0) {
      pickedIds.clear();
      for (const id of accepted) pickedIds.add(id);
    }
  }

  const bestNonPick = ranked.find((s) => !pickedIds.has(s.photo_id));
  // Δ for confidence gate is measured against the best non-pick. With
  // multi-pick the "boring" runner-ups are excluded from the gap, so a
  // group where the top 3 photos cluster around 0.78 and the rest sit
  // at 0.30 still ranks as high confidence.
  //
  // When every photo is multi-picked (no non-pick at all), there is
  // nothing to auto-hide and no meaningful gap to measure, so we treat
  // the group as low confidence.
  const runnerUpDelta = bestNonPick ? topScore - bestNonPick.score : 0;
  let confidence: AiConfidence;
  if (runnerUpDelta >= HIGH_CONFIDENCE_DELTA) confidence = "high";
  else if (runnerUpDelta >= MEDIUM_CONFIDENCE_DELTA) confidence = "medium";
  else confidence = "low";

  return {
    picked_photo_ids: [...pickedIds].sort((a, b) => a - b),
    confidence,
    details: {
      runner_up_delta: runnerUpDelta,
      multi_pick_threshold: MULTI_PICK_THRESHOLD,
      scores,
      ...(suppressed.length > 0 ? { redundancy_suppressed: suppressed } : {}),
      ...(promoted.length > 0 ? { diversity_promoted: promoted } : {}),
    },
  };
}
