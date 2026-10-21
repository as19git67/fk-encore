import { describe, expect, it } from "vitest";
import {
  compositeFromDetails,
  inWindow,
  isAestheticScore,
  localMinutes,
  parseHm,
  scaleQAlign,
  withAestheticScores,
} from "./aesthetic-score";

const BERLIN = "Europe/Berlin";
// 2026-10-20 is summer time in Berlin: UTC+2.
const at = (utc: string) => new Date(`2026-10-20T${utc}:00Z`);

describe("scaleQAlign", () => {
  it("maps the 1–5 scale onto 0–1 and clamps the ends", () => {
    expect(scaleQAlign(1)).toBe(0);
    expect(scaleQAlign(3)).toBe(0.5);
    expect(scaleQAlign(5)).toBe(1);
    expect(scaleQAlign(0.4)).toBe(0);
    expect(scaleQAlign(5.3)).toBe(1);
    expect(scaleQAlign(3.837)).toBe(0.71);
  });
});

describe("the window", () => {
  it("reads HH:MM and nothing else", () => {
    expect(parseHm("01:00")).toBe(60);
    expect(parseHm(" 23:59 ")).toBe(23 * 60 + 59);
    expect(parseHm("24:00")).toBeNull();
    expect(parseHm("1:00")).toBeNull();
    expect(parseHm("eins")).toBeNull();
  });

  it("is read in local time", () => {
    expect(localMinutes(at("23:30"), BERLIN)).toBe(90); // 01:30 the next day in Berlin
  });

  it("holds from start up to, not including, the end", () => {
    expect(inWindow(at("22:59"), "01:00", "06:00", BERLIN)).toBe(false);
    expect(inWindow(at("23:00"), "01:00", "06:00", BERLIN)).toBe(true);
    expect(inWindow(at("03:59"), "01:00", "06:00", BERLIN)).toBe(true);
    expect(inWindow(at("04:00"), "01:00", "06:00", BERLIN)).toBe(false);
  });

  it("may cross midnight", () => {
    expect(inWindow(at("20:30"), "22:00", "05:00", BERLIN)).toBe(true); // 22:30
    expect(inWindow(at("02:00"), "22:00", "05:00", BERLIN)).toBe(true); // 04:00
    expect(inWindow(at("10:00"), "22:00", "05:00", BERLIN)).toBe(false); // 12:00
  });

  it("is empty when the ends are equal or a time is unreadable", () => {
    expect(inWindow(at("23:30"), "01:00", "01:00", BERLIN)).toBe(false);
    expect(inWindow(at("23:30"), "1 Uhr", "06:00", BERLIN)).toBe(false);
  });
});

describe("compositeFromDetails", () => {
  const base = {
    clip_aesthetics: 0.6,
    clip_composition: 0.5,
    clip_technical: 0.4,
    sharpness: 0.8,
    contrast: 0.7,
    exposure: 0.9,
  };

  it("follows the formula of the quality endpoint", () => {
    // 0.30·0.6 + 0.20·0.5 + 0.10·0.4 + 0.25·0.8 + 0.10·0.7 + 0.05·0.9
    expect(compositeFromDetails(base)).toBeCloseTo(0.635, 6);
  });

  it("blends face sharpness, the eyes penalty and face composition like the scan does", () => {
    const blur = 0.35 * 0.8 + 0.65 * 0.5;
    let expected = 0.18 + 0.1 + 0.04 + 0.25 * blur + 0.07 + 0.045;
    expected *= 0.75 + 0.25 * 0.4;
    expected = expected * 0.85 + 0.9 * 0.15;
    const score = compositeFromDetails({ ...base, face_sharpness: 0.5, eyes_open: 0.4, face_composition: 0.9 });
    expect(score).toBeCloseTo(expected, 6);
  });

  it("is null until the quality job has written its parts", () => {
    expect(compositeFromDetails({ clip_aesthetics: 0.7 })).toBeNull();
  });

  it("rises with a better aesthetic score and nothing else", () => {
    const low = compositeFromDetails(withAestheticScores(base, { aesthetics: 2, quality: 3 }))!;
    const high = compositeFromDetails(withAestheticScores(base, { aesthetics: 4.5, quality: 3 }))!;
    expect(high - low).toBeCloseTo(0.3 * (0.88 - 0.25), 6);
  });
});

describe("compositeFromDetails with adopted weights", () => {
  const qalign = {
    clip_aesthetics: 0.6,
    clip_composition: 0.1,
    clip_technical: 0.1,
    qalign_quality: 0.5,
    sharpness: 0.8,
    contrast: 0.7,
    exposure: 0.9,
    face_composition: 0.2,
  };
  const weights = { aesthetics: 0.5, quality: 0.25, blur: 0.25 };

  it("leaves the CLIP prompts and the face composition out for a Q-Align photo", () => {
    expect(compositeFromDetails(qalign, weights)).toBeCloseTo(0.5 * 0.6 + 0.25 * 0.5 + 0.25 * 0.8, 6);
    expect(compositeFromDetails({ ...qalign, clip_composition: 0.9, face_composition: 0.9 }, weights)).toBeCloseTo(
      compositeFromDetails(qalign, weights)!,
      6,
    );
  });

  it("still lowers the score for closed eyes and uses the face's sharpness", () => {
    const blur = 0.35 * 0.8 + 0.65 * 0.4;
    const expected = (0.5 * 0.6 + 0.25 * 0.5 + 0.25 * blur) * (0.75 + 0.25 * 0.2);
    expect(compositeFromDetails({ ...qalign, face_sharpness: 0.4, eyes_open: 0.2 }, weights)).toBeCloseTo(expected, 6);
  });

  it("keeps the original formula for a photo without a Q-Align value", () => {
    const { qalign_quality: _, ...clipOnly } = qalign;
    expect(compositeFromDetails(clipOnly, weights)).toBeCloseTo(compositeFromDetails(clipOnly)!, 6);
  });

  it("keeps the original formula while no weights are adopted", () => {
    expect(compositeFromDetails(qalign)).toBeCloseTo(
      (0.18 + 0.02 + 0.01 + 0.25 * 0.8 + 0.07 + 0.045) * 0.85 + 0.2 * 0.15,
      6,
    );
  });
});

describe("withAestheticScores", () => {
  it("replaces clip_aesthetics under the same key and adds qalign_quality", () => {
    expect(withAestheticScores({ sharpness: 0.8, clip_aesthetics: 0.2 }, { aesthetics: 4, quality: 2 })).toEqual({
      sharpness: 0.8,
      clip_aesthetics: 0.75,
      qalign_quality: 0.25,
    });
    expect(withAestheticScores(null, { aesthetics: 5, quality: 5 })).toEqual({ clip_aesthetics: 1, qalign_quality: 1 });
  });
});

describe("isAestheticScore", () => {
  it("counts Q-Align scores, not failure marks or the CLIP signal", () => {
    expect(isAestheticScore("qalign_v1")).toBe(true);
    expect(isAestheticScore("qalign_v1:failed")).toBe(false);
    expect(isAestheticScore(null)).toBe(false);
    expect(isAestheticScore("laion_vith_v1")).toBe(false);
  });
});
