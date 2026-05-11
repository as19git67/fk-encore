import { describe, expect, it } from "vitest";
import {
  HIGH_CONFIDENCE_DELTA,
  MEDIUM_CONFIDENCE_DELTA,
  MULTI_PICK_THRESHOLD,
  computeGroupPick,
  scorePhoto,
  type PhotoSignals,
} from "./group-auto-pick";

function basePhoto(overrides: Partial<PhotoSignals> = {}): PhotoSignals {
  return {
    photo_id: 0,
    blur_score: 0.5,
    contrast_score: 0.5,
    exposure_score: 0.5,
    clip_aesthetics: 0.5,
    clip_composition: 0.5,
    clip_technical: 0.5,
    face_sharpness: 0.5,
    eyes_open_score: 0.5,
    face_count: 0,
    face_coverage: 0,
    ...overrides,
  };
}

describe("scorePhoto", () => {
  it("uses the face branch when face_count > 0", () => {
    const result = scorePhoto(basePhoto({ photo_id: 1, face_count: 2 }));
    expect(result.has_face).toBe(true);
    expect(result.signals.face_sharpness).toBeDefined();
    expect(result.signals.clip_composition).toBeUndefined();
  });

  it("uses the non-face branch when face_count = 0", () => {
    const result = scorePhoto(basePhoto({ photo_id: 1 }));
    expect(result.has_face).toBe(false);
    expect(result.signals.face_sharpness).toBeUndefined();
    expect(result.signals.clip_composition).toBeDefined();
  });

  it("rewards face_sharpness most heavily in the face branch", () => {
    const sharp = scorePhoto(
      basePhoto({ photo_id: 1, face_count: 1, face_sharpness: 1.0 }),
    );
    const blurry = scorePhoto(
      basePhoto({ photo_id: 1, face_count: 1, face_sharpness: 0.0 }),
    );
    // Weight 0.45 on face_sharpness → at least 0.4 spread between the
    // two extremes, leaving headroom for the other signals.
    expect(sharp.score - blurry.score).toBeGreaterThanOrEqual(0.4);
  });

  it("rewards blur_score most heavily in the non-face branch", () => {
    const sharp = scorePhoto(basePhoto({ photo_id: 1, blur_score: 1.0 }));
    const blurry = scorePhoto(basePhoto({ photo_id: 1, blur_score: 0.0 }));
    expect(sharp.score - blurry.score).toBeCloseTo(0.4, 5);
  });

  it("saturates face_coverage above 30% of the frame", () => {
    const tight = scorePhoto(
      basePhoto({ photo_id: 1, face_count: 1, face_coverage: 0.30 }),
    );
    const huge = scorePhoto(
      basePhoto({ photo_id: 1, face_count: 1, face_coverage: 0.95 }),
    );
    expect(huge.score).toBeCloseTo(tight.score, 6);
  });

  it("treats missing signals as neutral 0.5, not 0", () => {
    const allMissing = scorePhoto({
      photo_id: 1,
      face_count: 0,
      face_coverage: 0,
    });
    // Neutral inputs → score near 0.5 (weights sum to 1.0).
    expect(allMissing.score).toBeCloseTo(0.5, 6);
  });

  it("clamps out-of-range signals to [0, 1]", () => {
    const huge = scorePhoto(basePhoto({ photo_id: 1, blur_score: 12.0 }));
    const clamped = scorePhoto(basePhoto({ photo_id: 1, blur_score: 1.0 }));
    expect(huge.score).toBeCloseTo(clamped.score, 6);
  });
});

describe("computeGroupPick — pick & multi-pick", () => {
  it("picks the highest-scoring photo as top-1", () => {
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.2 }),
      basePhoto({ photo_id: 2, blur_score: 0.9 }),
      basePhoto({ photo_id: 3, blur_score: 0.4 }),
    ]);
    expect(result.picked_photo_ids).toContain(2);
  });

  it("includes runner-ups within MULTI_PICK_THRESHOLD of top", () => {
    // Two near-tied non-face photos: blur 0.9 vs 0.85. With weight 0.4
    // their scores differ by 0.02, well within the 8% threshold.
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.9 }),
      basePhoto({ photo_id: 2, blur_score: 0.85 }),
      basePhoto({ photo_id: 3, blur_score: 0.1 }),
    ]);
    expect(result.picked_photo_ids.sort()).toEqual([1, 2]);
  });

  it("excludes photos below the multi-pick cutoff", () => {
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 1.0 }),
      basePhoto({ photo_id: 2, blur_score: 0.1 }),
    ]);
    expect(result.picked_photo_ids).toEqual([1]);
  });

  it("returns ids sorted ascending (deterministic for UI ordering)", () => {
    const result = computeGroupPick([
      basePhoto({ photo_id: 99, blur_score: 0.9 }),
      basePhoto({ photo_id: 5, blur_score: 0.9 }),
      basePhoto({ photo_id: 42, blur_score: 0.1 }),
    ]);
    expect(result.picked_photo_ids).toEqual([5, 99]);
  });

  it("breaks score ties deterministically by lower photo_id", () => {
    // Two photos with identical signals → identical scores. Lower ID
    // wins as top-1; both end up in the multi-pick set.
    const result = computeGroupPick([
      basePhoto({ photo_id: 7, blur_score: 0.8 }),
      basePhoto({ photo_id: 3, blur_score: 0.8 }),
      basePhoto({ photo_id: 11, blur_score: 0.1 }),
    ]);
    expect(result.picked_photo_ids).toEqual([3, 7]);
  });
});

describe("computeGroupPick — confidence gate", () => {
  it("returns 'high' when top beats runner-up by ≥ HIGH delta", () => {
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 1.0 }),
      basePhoto({ photo_id: 2, blur_score: 0.0 }),
    ]);
    // Non-face branch: weight 0.4 on blur. Δ = 0.4 ≫ 0.10.
    expect(result.confidence).toBe("high");
    expect(result.details.runner_up_delta).toBeGreaterThanOrEqual(
      HIGH_CONFIDENCE_DELTA,
    );
  });

  it("returns 'medium' when delta is between MEDIUM and HIGH", () => {
    // blur diff 0.20 in non-face branch → score diff ~0.08, between 0.04
    // and 0.10.
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.6 }),
      basePhoto({ photo_id: 2, blur_score: 0.4 }),
    ]);
    expect(result.confidence).toBe("medium");
    expect(result.details.runner_up_delta).toBeGreaterThanOrEqual(
      MEDIUM_CONFIDENCE_DELTA,
    );
    expect(result.details.runner_up_delta).toBeLessThan(HIGH_CONFIDENCE_DELTA);
  });

  it("returns 'low' when the top photo is essentially tied with another", () => {
    // blur diff 0.05 → score diff 0.02 < 0.04. Both end up multi-picked,
    // so the runner-up gap is measured against the next-best photo.
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.50 }),
      basePhoto({ photo_id: 2, blur_score: 0.55 }),
      basePhoto({ photo_id: 3, blur_score: 0.54 }),
    ]);
    expect(result.confidence).toBe("low");
  });

  it("measures runner-up delta against the best non-pick, not the second-best score", () => {
    // Three near-tied tops + one far-behind. The two near-ties multi-pick
    // together; the gap must be measured against the laggard, not within
    // the top trio.
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.90 }),
      basePhoto({ photo_id: 2, blur_score: 0.88 }),
      basePhoto({ photo_id: 3, blur_score: 0.20 }),
    ]);
    expect(result.picked_photo_ids.sort()).toEqual([1, 2]);
    // Δ vs photo 3 ≈ 0.4·(0.88 − 0.20) ≈ 0.27
    expect(result.confidence).toBe("high");
  });
});

describe("computeGroupPick — persistence shape", () => {
  it("persists every photo's sub-signal breakdown for calibration", () => {
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, face_count: 1, face_sharpness: 0.9 }),
      basePhoto({ photo_id: 2, face_count: 0, blur_score: 0.4 }),
    ]);
    expect(result.details.scores).toHaveLength(2);
    expect(result.details.scores.find((s) => s.photo_id === 1)?.has_face).toBe(true);
    expect(result.details.scores.find((s) => s.photo_id === 2)?.has_face).toBe(false);
    expect(result.details.multi_pick_threshold).toBe(MULTI_PICK_THRESHOLD);
  });

  it("handles degenerate single-photo input without crashing", () => {
    const result = computeGroupPick([basePhoto({ photo_id: 42 })]);
    expect(result.picked_photo_ids).toEqual([42]);
    expect(result.confidence).toBe("low");
  });
});
