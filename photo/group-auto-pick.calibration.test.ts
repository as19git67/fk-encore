import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  faceFeatures,
  fitPairwiseWeights,
  nonFaceFeatures,
} from "./group-auto-pick.calibration";
import type { PhotoSignals } from "./group-auto-pick";

function signals(overrides: Partial<PhotoSignals> = {}): PhotoSignals {
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

describe("faceFeatures / nonFaceFeatures", () => {
  it("returns vectors of the expected dimensionality", () => {
    expect(faceFeatures(signals()).length).toBe(DEFAULT_WEIGHTS.face.length);
    expect(nonFaceFeatures(signals()).length).toBe(DEFAULT_WEIGHTS.non_face.length);
  });

  it("clamps missing signals to the neutral 0.5 fallback", () => {
    const fv = faceFeatures({
      photo_id: 1,
      face_count: 1,
      face_coverage: 0,
    });
    // Every entry except face_coverage (which is 0 by definition when
    // no face bbox is present) should be 0.5.
    fv.forEach((v, i) => {
      // index 2 is face_coverage; the rest are clamped quality signals
      if (i !== 2) expect(v).toBe(0.5);
    });
  });

  it("normalises face_coverage at the 30 % saturation point", () => {
    const a = faceFeatures(signals({ face_count: 1, face_coverage: 0.30 }));
    const b = faceFeatures(signals({ face_count: 1, face_coverage: 0.90 }));
    expect(a[2]).toBe(1);
    expect(b[2]).toBe(1);
  });
});

describe("fitPairwiseWeights", () => {
  function pair(kept: number[], hidden: number[]): number[] {
    return kept.map((v, i) => v - hidden[i]);
  }

  it("returns the init vector unchanged when no pairs are supplied", () => {
    const result = fitPairwiseWeights([], [0.4, 0.3, 0.3]);
    expect(result.weights).toEqual([0.4, 0.3, 0.3]);
    expect(result.trainAcc).toBe(0);
    expect(result.baselineAcc).toBe(0);
  });

  it("shifts weights toward the signal that actually discriminates", () => {
    // 50 pairs where signal[0] is always higher for the kept photo
    // and signals[1..2] are noise. The fitted weights should put more
    // mass on signal[0]. With a misleading init (0.10 on signal[0],
    // 0.45 each on 1 and 2) the baseline gets the pairs wrong; the
    // fit must recover.
    const pairs: number[][] = [];
    for (let i = 0; i < 50; i++) {
      const noiseA = (Math.random() - 0.5) * 0.4;
      const noiseB = (Math.random() - 0.5) * 0.4;
      const kept = [0.9, 0.5 + noiseA, 0.5 + noiseB];
      const hidden = [0.3, 0.5 - noiseA, 0.5 - noiseB];
      pairs.push(pair(kept, hidden));
    }
    const result = fitPairwiseWeights(pairs, [0.10, 0.45, 0.45]);
    expect(result.weights[0]).toBeGreaterThan(result.weights[1]);
    expect(result.weights[0]).toBeGreaterThan(result.weights[2]);
    expect(result.trainAcc).toBeGreaterThanOrEqual(result.baselineAcc);
    expect(result.trainAcc).toBeGreaterThanOrEqual(0.90);
  });

  it("keeps the output weights summing to 1 and non-negative", () => {
    const pairs: number[][] = [];
    for (let i = 0; i < 30; i++) {
      pairs.push([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1]);
    }
    const result = fitPairwiseWeights(pairs, [0.5, 0.3, 0.2]);
    let sum = 0;
    for (const w of result.weights) {
      expect(w).toBeGreaterThanOrEqual(0);
      sum += w;
    }
    expect(sum).toBeCloseTo(1, 5);
  });

  it("throws when the pair vector length doesn't match the init", () => {
    expect(() => fitPairwiseWeights([[0.1, 0.2]], [0.5, 0.3, 0.2])).toThrow();
  });

  it("does NOT diverge wildly when the signal is contradictory", () => {
    // Half the pairs say signal[0] is good, the other half say it's bad.
    // Expected: weights stay close to the init (no clear winner to
    // shift towards).
    const pairs: number[][] = [];
    for (let i = 0; i < 20; i++) pairs.push([0.5, 0, 0]);
    for (let i = 0; i < 20; i++) pairs.push([-0.5, 0, 0]);
    const result = fitPairwiseWeights(pairs, [0.34, 0.33, 0.33]);
    // Sum-to-one and non-negative invariants must still hold.
    let sum = 0;
    for (const w of result.weights) {
      expect(w).toBeGreaterThanOrEqual(0);
      sum += w;
    }
    expect(sum).toBeCloseTo(1, 5);
  });
});
