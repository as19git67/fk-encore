import { describe, it, expect } from "vitest";
import {
  bboxIoU,
  eyeAspect106,
  eyeAspect68,
  eyeOpennessFromContour,
  matchDetections,
  measureFaceEyes,
  MIN_EYE_FACE_PIXELS,
  type Point,
} from "./face-eyes";

/** Ten points on an ellipse — an eye contour of the given width and height,
 *  rotated by `angle`, in shuffled order. */
function eyeContour(cx: number, cy: number, width: number, height: number, angle = 0): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < 10; i++) {
    const t = (i / 10) * 2 * Math.PI;
    const x = (width / 2) * Math.cos(t);
    const y = (height / 2) * Math.sin(t);
    pts.push([
      cx + x * Math.cos(angle) - y * Math.sin(angle),
      cy + x * Math.sin(angle) + y * Math.cos(angle),
    ]);
  }
  // Order must not matter.
  return [pts[3], pts[7], pts[0], pts[9], pts[5], pts[1], pts[8], pts[2], pts[6], pts[4]];
}

function face106(eyeHeight: number): Point[] {
  const pts: Point[] = Array.from({ length: 106 }, () => [100, 100] as Point);
  eyeContour(70, 80, 30, eyeHeight).forEach((p, i) => (pts[33 + i] = p));
  eyeContour(130, 80, 30, eyeHeight).forEach((p, i) => (pts[87 + i] = p));
  return pts;
}

function face68(lid: number): Point[] {
  const pts: Point[] = Array.from({ length: 68 }, () => [100, 100] as Point);
  const eye = (base: number, x0: number) => {
    pts[base] = [x0, 80];
    pts[base + 1] = [x0 + 10, 80 - lid];
    pts[base + 2] = [x0 + 20, 80 - lid];
    pts[base + 3] = [x0 + 30, 80];
    pts[base + 4] = [x0 + 20, 80 + lid];
    pts[base + 5] = [x0 + 10, 80 + lid];
  };
  eye(36, 55);
  eye(42, 115);
  return pts;
}

describe("eyeOpennessFromContour", () => {
  it("is height over width of the contour", () => {
    // Ten samples of an ellipse don't reach the exact vertices, so allow a
    // few percent.
    expect(eyeOpennessFromContour(eyeContour(0, 0, 30, 12))!).toBeCloseTo(0.4, 1);
  });

  it("does not change when the head is tilted", () => {
    const level = eyeOpennessFromContour(eyeContour(0, 0, 30, 9))!;
    const tilted = eyeOpennessFromContour(eyeContour(0, 0, 30, 9, 0.5))!;
    expect(tilted).toBeCloseTo(level, 2);
  });

  it("returns null for a degenerate contour", () => {
    expect(eyeOpennessFromContour([[1, 1], [1, 1], [1, 1], [1, 1]])).toBeNull();
    expect(eyeOpennessFromContour([[1, 1]])).toBeNull();
  });
});

describe("eyeAspect106", () => {
  it("separates open from closed eyes", () => {
    const open = eyeAspect106(face106(12))!;
    const closed = eyeAspect106(face106(2))!;
    expect(open).toBeGreaterThan(0.3);
    expect(closed).toBeLessThan(0.1);
  });

  it("needs the full set", () => {
    expect(eyeAspect106(face106(12).slice(0, 100))).toBeNull();
  });
});

describe("eyeAspect68", () => {
  it("is the textbook EAR", () => {
    // Lid distance 2·lid over corner distance 30.
    expect(eyeAspect68(face68(5))!).toBeCloseTo(10 / 30, 6);
    expect(eyeAspect68(face68(1))!).toBeCloseTo(2 / 30, 6);
  });
});

describe("measureFaceEyes", () => {
  const raw = {
    kps: [[70, 80], [130, 80], [100, 110], [80, 140], [120, 140]],
    landmark_2d_106: face106(12),
    landmark_3d_68: face68(5),
  };

  it("measures on pixels and stores normalised landmarks", () => {
    // Non-square image: normalising before measuring would distort the eye.
    const m = measureFaceEyes(raw, 120, 400, 200);
    expect(m.eyeAspect68).toBeCloseTo(0.3333, 4);
    expect(m.eyeAspect).toBeGreaterThan(0.3);
    expect(m.landmarks!.kps![0]).toEqual([0.175, 0.4]);
    expect(m.landmarks!.lm106).toHaveLength(106);
    expect(m.landmarks!.lm68).toHaveLength(68);
  });

  it("keeps the landmarks but no ratio for faces below the size limit", () => {
    const m = measureFaceEyes(raw, MIN_EYE_FACE_PIXELS - 1, 400, 200);
    expect(m.eyeAspect).toBeNull();
    expect(m.eyeAspect68).toBeNull();
    expect(m.landmarks).not.toBeNull();
  });

  it("stores nothing when the service sent no landmarks", () => {
    const m = measureFaceEyes({}, 200, 400, 200);
    expect(m).toEqual({ landmarks: null, eyeAspect: null, eyeAspect68: null });
  });

  it("ignores a malformed set instead of storing garbage", () => {
    const m = measureFaceEyes({ ...raw, landmark_2d_106: [[1, 2]] }, 200, 400, 200);
    expect(m.landmarks!.lm106).toBeNull();
    expect(m.eyeAspect).toBeNull();
    expect(m.eyeAspect68).not.toBeNull();
  });
});

describe("matchDetections", () => {
  const a = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
  const b = { x: 0.6, y: 0.1, width: 0.2, height: 0.2 };

  it("computes IoU", () => {
    expect(bboxIoU(a, a)).toBeCloseTo(1, 9);
    expect(bboxIoU(a, b)).toBe(0);
  });

  it("pairs stored faces with the re-detection regardless of order", () => {
    const detected = [
      { ...b, x: 0.601 },
      { ...a, y: 0.102 },
    ];
    expect(matchDetections([a, b], detected)).toEqual([1, 0]);
  });

  it("leaves a face unmatched rather than guessing", () => {
    expect(matchDetections([a, null], [b])).toEqual([null, null]);
  });

  it("gives each detection to one stored face only", () => {
    const nearlyA = { ...a, x: 0.105 };
    expect(matchDetections([a, nearlyA], [a])).toEqual([0, null]);
  });
});
