import { describe, expect, it } from "vitest";
import { DEFAULT_COMPOSITE_WEIGHTS, compositeFromDetails } from "./aesthetic-score";
import {
  compositeHits,
  detailsOf,
  fitCompositeWeights,
  replayCompositeOnGroups,
} from "./composite-replay";
import { MIN_REPLAY_GROUPS, type TrainingGroup } from "./group-auto-pick.calibration";
import type { PhotoSignals } from "./group-auto-pick";

function signals(overrides: Partial<PhotoSignals>): PhotoSignals {
  return {
    photo_id: 0,
    blur_score: 0.6,
    contrast_score: 0.5,
    exposure_score: 0.5,
    clip_aesthetics: 0.5,
    clip_composition: 0.5,
    clip_technical: 0.5,
    qalign_quality: 0.5,
    face_count: 0,
    face_coverage: 0,
    ...overrides,
  };
}

/**
 * The hidden photo wins on the CLIP prompts, the kept one on Q-Align: the
 * original formula ranks the hidden one first, one without CLIP the kept one.
 */
function group(id: number, opts: { qalign?: boolean } = {}): TrainingGroup {
  const qalign = opts.qalign ?? true;
  const hidden = id * 10 + 1;
  const kept = id * 10 + 2;
  return {
    group_id: id,
    photos: [
      {
        photo_id: hidden,
        user_kept: false,
        has_face: false,
        qalign,
        signals: signals({ photo_id: hidden, clip_aesthetics: 0.5, clip_composition: 0.95, clip_technical: 0.95, qalign_quality: 0.4 }),
      },
      {
        photo_id: kept,
        user_kept: true,
        has_face: false,
        qalign,
        signals: signals({ photo_id: kept, clip_aesthetics: 0.6, clip_composition: 0.1, clip_technical: 0.1, qalign_quality: 0.6 }),
      },
    ],
  };
}

describe("detailsOf", () => {
  it("names the signals by their ai_quality_details keys", () => {
    const d = detailsOf(signals({ photo_id: 1, eyes_open_score: 0.3, face_sharpness: null }));
    expect(d).toMatchObject({ sharpness: 0.6, eyes_open: 0.3, qalign_quality: 0.5, clip_composition: 0.5 });
    expect(d).not.toHaveProperty("face_sharpness");
    expect(compositeFromDetails(d)).not.toBeNull();
  });
});

describe("compositeHits", () => {
  it("counts a group as hit when the top-ranked photo was kept", () => {
    const groups = [group(1), group(2)];
    expect(compositeHits(groups, null)).toEqual({ groups: 2, hits: 0 });
    expect(compositeHits(groups, DEFAULT_COMPOSITE_WEIGHTS)).toEqual({ groups: 2, hits: 2 });
  });
});

describe("fitCompositeWeights", () => {
  it("keeps the starting point with too few pairs", () => {
    expect(fitCompositeWeights([group(1)])).toEqual(DEFAULT_COMPOSITE_WEIGHTS);
  });

  it("learns weights that sum to one and still rank the kept photos first", () => {
    const groups = Array.from({ length: 20 }, (_, i) => group(i + 1));
    const w = fitCompositeWeights(groups);
    expect(w.aesthetics + w.quality + w.blur).toBeCloseTo(1, 6);
    expect(compositeHits(groups, w).hits).toBe(20);
  });
});

describe("replayCompositeOnGroups", () => {
  it("recommends dropping the CLIP prompts when that is what the reviews show", () => {
    const groups = Array.from({ length: MIN_REPLAY_GROUPS + 5 }, (_, i) => group(i + 1));
    const report = replayCompositeOnGroups(groups, null);
    const rate = (key: string) => report.variants.find((v) => v.key === key)!.hit_rate;
    expect(rate("current")).toBe(0);
    expect(rate("default")).toBe(1);
    expect(report.recommended).toBe("default");
    expect(report.reason).toBeNull();
  });

  it("needs enough groups scored by Q-Align throughout", () => {
    const groups = [
      ...Array.from({ length: 5 }, (_, i) => group(i + 1)),
      ...Array.from({ length: 50 }, (_, i) => group(i + 100, { qalign: false })),
    ];
    const report = replayCompositeOnGroups(groups, null);
    expect(report.decided_groups).toBe(55);
    expect(report.qalign_groups).toBe(5);
    expect(report.recommended).toBeNull();
    expect(report.reason).toMatch(/Erst 5/);
  });

  it("recommends nothing when today's formula already does as well", () => {
    const groups = Array.from({ length: MIN_REPLAY_GROUPS + 5 }, (_, i) => group(i + 1));
    const report = replayCompositeOnGroups(groups, DEFAULT_COMPOSITE_WEIGHTS);
    expect(report.recommended).toBeNull();
    expect(report.reason).toMatch(/nicht spürbar/);
  });

  it("leaves out groups without a measured sharpness", () => {
    const g = group(1);
    g.photos[0]!.signals.blur_score = null;
    expect(replayCompositeOnGroups([g], null).qalign_groups).toBe(0);
  });
});
