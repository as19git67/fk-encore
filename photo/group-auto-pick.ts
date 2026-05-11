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

/** Compute the per-photo score and its sub-signal breakdown. */
export function scorePhoto(signals: PhotoSignals): AiPickPhotoScore {
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
    score =
      0.45 * faceSharpness +
      0.20 * eyesOpen +
      0.15 * faceCoverage +
      0.10 * blur +
      0.05 * aesthetics +
      0.05 * exposureContrast;
    used.face_sharpness = faceSharpness;
    used.eyes_open = eyesOpen;
    used.face_coverage = faceCoverage;
    used.blur = blur;
    used.clip_aesthetics = aesthetics;
    used.contrast = contrast;
    used.exposure = exposure;
  } else {
    score =
      0.40 * blur +
      0.25 * aesthetics +
      0.15 * composition +
      0.10 * technical +
      0.10 * exposureContrast;
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
export function computeGroupPick(photos: PhotoSignals[]): AiPickResult {
  if (photos.length < 2) {
    return {
      picked_photo_ids: photos.map((p) => p.photo_id),
      confidence: "low",
      details: {
        runner_up_delta: 0,
        multi_pick_threshold: MULTI_PICK_THRESHOLD,
        scores: photos.map((p) => scorePhoto(p)),
      },
    };
  }

  const scores = photos.map((p) => scorePhoto(p));
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
    },
  };
}
