import { describe, expect, it } from "vitest";
import {
  HIGH_CONFIDENCE_DELTA,
  MEDIUM_CONFIDENCE_DELTA,
  MULTI_PICK_THRESHOLD,
  ORIENTATION_FLOOR,
  classifyOrientation,
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
    face_composition: 0.5,
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
    // Weight 0.40 on face_sharpness → at least 0.35 spread between the
    // two extremes, leaving headroom for the other signals.
    expect(sharp.score - blurry.score).toBeGreaterThanOrEqual(0.35);
  });

  it("rewards face_composition in the face branch", () => {
    const wellComposed = scorePhoto(
      basePhoto({ photo_id: 1, face_count: 1, face_composition: 1.0 }),
    );
    const badlyComposed = scorePhoto(
      basePhoto({ photo_id: 1, face_count: 1, face_composition: 0.0 }),
    );
    // Weight 0.10 on face_composition → ~0.10 spread.
    expect(wellComposed.score - badlyComposed.score).toBeCloseTo(0.10, 5);
  });

  it("ignores face_composition in the non-face branch", () => {
    const a = scorePhoto(basePhoto({ photo_id: 1, face_composition: 1.0 }));
    const b = scorePhoto(basePhoto({ photo_id: 2, face_composition: 0.0 }));
    expect(a.score).toBeCloseTo(b.score, 6);
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

describe("classifyOrientation", () => {
  it("classifies wide ratios as landscape", () => {
    expect(classifyOrientation(3000, 2000)).toBe("landscape");
    expect(classifyOrientation(4032, 3024)).toBe("landscape");
  });

  it("classifies tall ratios as portrait", () => {
    expect(classifyOrientation(2000, 3000)).toBe("portrait");
    expect(classifyOrientation(3024, 4032)).toBe("portrait");
  });

  it("classifies near-square ratios as square", () => {
    expect(classifyOrientation(1000, 1000)).toBe("square");
    expect(classifyOrientation(1050, 1000)).toBe("square");
    expect(classifyOrientation(1000, 1050)).toBe("square");
  });

  it("defaults to landscape when dimensions are missing", () => {
    expect(classifyOrientation(null, null)).toBe("landscape");
    expect(classifyOrientation(undefined, undefined)).toBe("landscape");
    expect(classifyOrientation(0, 0)).toBe("landscape");
  });
});

describe("computeGroupPick — orientation diversity", () => {
  it("promotes the best photo of each present orientation when above the floor", () => {
    // Two portraits, one landscape — the landscape is mildly worse
    // (blur 0.55 vs the portraits' 0.90) but above the 0.75 floor of
    // the top, so it joins the multi-pick.
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.90, orientation: "portrait" }),
      basePhoto({ photo_id: 2, blur_score: 0.85, orientation: "portrait" }),
      basePhoto({ photo_id: 3, blur_score: 0.85, orientation: "landscape" }),
    ]);
    expect(result.picked_photo_ids).toContain(3);
  });

  it("excludes an orientation whose best is below the floor", () => {
    // A single landscape that is catastrophically worse than the
    // portrait pack (0.10 vs 0.90 blur) — the diversity rule must
    // NOT promote it. Score gap is far below 0.75·top.
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.90, orientation: "portrait" }),
      basePhoto({ photo_id: 2, blur_score: 0.85, orientation: "portrait" }),
      basePhoto({ photo_id: 3, blur_score: 0.10, orientation: "landscape" }),
    ]);
    expect(result.picked_photo_ids).not.toContain(3);
  });

  it("ignores square photos so a near-square outlier does not kidnap a slot", () => {
    // A portrait burst with one square photo: the square's score is
    // intentionally below the multi-pick cutoff. Without the square
    // exclusion the orientation rule would still rescue it (its score
    // is above the 0.75 floor of the top). The exclusion keeps it out.
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.90, orientation: "portrait" }),
      basePhoto({ photo_id: 2, blur_score: 0.50, orientation: "portrait" }),
      basePhoto({ photo_id: 3, blur_score: 0.55, orientation: "square" }),
    ]);
    expect(result.picked_photo_ids).not.toContain(3);
  });

  it("no-ops when every photo shares the same orientation", () => {
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.90, orientation: "portrait" }),
      basePhoto({ photo_id: 2, blur_score: 0.10, orientation: "portrait" }),
    ]);
    // Same as before the orientation rule: top wins, runner-up
    // excluded via the multi-pick threshold.
    expect(result.picked_photo_ids).toEqual([1]);
  });

  it("no-ops when orientations are missing entirely (pre-backfill default)", () => {
    // Pure pre-backfill input — orientation undefined → rule must not
    // mistake a homogenous unknown group for diverse.
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.90 }),
      basePhoto({ photo_id: 2, blur_score: 0.10 }),
    ]);
    expect(result.picked_photo_ids).toEqual([1]);
  });

  it("respects the multi-pick set the standard rule already produced", () => {
    // Two near-tied portraits multi-pick by score, plus one landscape
    // mildly worse — the landscape joins via the orientation rule.
    // Final pick set should contain all three.
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.90, orientation: "portrait" }),
      basePhoto({ photo_id: 2, blur_score: 0.88, orientation: "portrait" }),
      basePhoto({ photo_id: 3, blur_score: 0.80, orientation: "landscape" }),
    ]);
    expect(result.picked_photo_ids.sort()).toEqual([1, 2, 3]);
  });

  it("does not affect confidence: orientation pick of a clear winner stays 'high'", () => {
    // Top portrait clearly beats every non-pick (the landscape is part
    // of the pick set due to the diversity rule, so the gap is
    // measured against a much worse photo).
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.95, orientation: "portrait" }),
      basePhoto({ photo_id: 2, blur_score: 0.85, orientation: "landscape" }),
      basePhoto({ photo_id: 3, blur_score: 0.20, orientation: "portrait" }),
    ]);
    expect(result.picked_photo_ids.sort()).toEqual([1, 2]);
    expect(result.confidence).toBe("high");
  });

  it("persists the orientation on each per-photo score row", () => {
    const result = computeGroupPick([
      basePhoto({ photo_id: 1, blur_score: 0.90, orientation: "portrait" }),
      basePhoto({ photo_id: 2, blur_score: 0.85, orientation: "landscape" }),
    ]);
    const p1 = result.details.scores.find((s) => s.photo_id === 1);
    const p2 = result.details.scores.find((s) => s.photo_id === 2);
    expect(p1?.orientation).toBe("portrait");
    expect(p2?.orientation).toBe("landscape");
  });

  it("exposes ORIENTATION_FLOOR for documentation/tuning", () => {
    expect(ORIENTATION_FLOOR).toBeGreaterThan(0);
    expect(ORIENTATION_FLOOR).toBeLessThan(1);
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
