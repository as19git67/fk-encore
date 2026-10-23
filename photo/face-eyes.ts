/**
 * Eye openness per face from facial landmarks — Etappe 5 of
 * documentation/auto-pick-face-relevance.md, brought forward because it turned
 * out to be cheap.
 *
 * Today's `eyes_open` is a CLIP zero-shot score on each face crop ("open eyes"
 * vs "closed eyes blinking"), aggregated with `min()` over every face of the
 * photo. CLIP sees a blink poorly on small faces, and the minimum usually
 * measures a background face rather than the subject.
 *
 * The InsightFace service runs the `buffalo_l` pack, which includes two
 * landmark models besides the detector: `2d106det` (106 points) and `1k3d68`
 * (the classic 68-point layout). Both run on every face anyway; their output
 * used to be discarded. The eyelid points give a geometric measure of how far
 * the eye is open, with no new model and no GPU.
 *
 * Two measurements are kept side by side, because it is not known in advance
 * which model follows an eyelid that closes: the 68-point model is fitted
 * through a 3D face shape and may regress towards an open eye. The diagnosis
 * (`scripts/photos/diagnose-eyes-open.mjs`) compares both against the user's
 * own decisions before either is allowed into the score.
 *
 * Only raw ratios are stored. Where "closed" ends and "open" begins is a
 * calibration question for the replay, not a constant to guess here — the
 * same lesson as `faces.sharpness_variance`.
 *
 * The same landmarks also describe the mouth. Two raw measures stand in for
 * a smile (`mouthShape`): how wide the mouth is relative to the distance
 * between the eyes, and how far the corners sit above the middle of the
 * lips. Neither is a smile detector on its own; whether they track the
 * user's choice is again for the diagnosis to show.
 */

import type { FaceBBox } from "../db/types";

export type Point = [number, number];

/** Landmarks exactly as the InsightFace service returns them, in pixels of
 *  the image the detector saw. */
export interface RawFaceLandmarks {
  kps?: number[][] | null;
  landmark_2d_106?: number[][] | null;
  landmark_3d_68?: number[][] | null;
}

/** What `faces.landmarks` holds: the same three sets, normalised to 0..1
 *  against the detector's image size like `faces.bbox`. */
export interface StoredFaceLandmarks {
  kps: Point[] | null;
  lm106: Point[] | null;
  lm68: Point[] | null;
}

/** Faces narrower than this (detector pixels) get no eye or mouth measurement: the
 *  landmark models work on a 192 px crop, and below ~48 px the eyelid points
 *  are interpolation, not observation. NULL, deliberately not a number. */
export const MIN_EYE_FACE_PIXELS = 48;

/** Eye contours in the 106-point layout. The model's documentation is a
 *  picture; the ranges are the ones community code relies on (0–32 contour,
 *  33–42 and 87–96 eyes, 43–51 and 97–105 brows, 52–71 mouth, 72–86 nose).
 *  The order of points inside a range is not documented, which is why
 *  `eyeOpennessFromContour` does not depend on it. */
const EYE_RANGES_106: Array<[number, number]> = [[33, 42], [87, 96]];

const MOUTH_RANGE_106: [number, number] = [52, 71];
/** Outer (48–59) and inner (60–67) lip contour of the 68-point layout. */
const MOUTH_RANGE_68: [number, number] = [48, 67];

/** Eye contours in the 68-point (iBUG 300-W) layout: corner, two upper lid
 *  points, corner, two lower lid points — in that order. */
const EYES_68: Array<[number, number, number, number, number, number]> = [
  [36, 37, 38, 39, 40, 41],
  [42, 43, 44, 45, 46, 47],
];

function asPoints(raw: number[][] | null | undefined, expected: number): Point[] | null {
  if (!Array.isArray(raw) || raw.length !== expected) return null;
  const out: Point[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([x, y]);
  }
  return out;
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Height-to-width ratio of one eye contour, independent of point order.
 *
 * The long axis is the principal component of the points (the line through
 * both corners on any eye that is wider than tall); width and height are the
 * extents along that axis and across it. A tilted head therefore does not
 * read as an open eye. Returns null for a degenerate contour.
 */
export function eyeOpennessFromContour(points: Point[]): number | null {
  if (points.length < 4) return null;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  cx /= points.length;
  cy /= points.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    const dx = x - cx;
    const dy = y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // Orientation of the major axis of a 2×2 covariance matrix.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [x, y] of points) {
    const dx = x - cx;
    const dy = y - cy;
    const u = dx * ux + dy * uy;
    const v = -dx * uy + dy * ux;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const width = maxU - minU;
  if (!(width > 1e-6)) return null;
  return (maxV - minV) / width;
}

/** Mean openness of both eyes from the 106-point set (pixel coordinates). */
export function eyeAspect106(points: Point[]): number | null {
  if (points.length !== 106) return null;
  const values: number[] = [];
  for (const [from, to] of EYE_RANGES_106) {
    const v = eyeOpennessFromContour(points.slice(from, to + 1));
    if (v == null) return null;
    values.push(v);
  }
  return (values[0] + values[1]) / 2;
}

/**
 * Mean eye aspect ratio of both eyes from the 68-point set — the textbook
 * EAR (Soukupová & Čech, 2016): the two lid distances over twice the corner
 * distance. Open eyes sit around 0.25–0.35, a blink drops towards 0.1.
 */
export function eyeAspect68(points: Point[]): number | null {
  if (points.length !== 68) return null;
  const values: number[] = [];
  for (const [p1, p2, p3, p4, p5, p6] of EYES_68) {
    const width = dist(points[p1], points[p4]);
    if (!(width > 1e-6)) return null;
    values.push(
      (dist(points[p2], points[p6]) + dist(points[p3], points[p5])) / (2 * width),
    );
  }
  return (values[0] + values[1]) / 2;
}

const centroid = (points: Point[]): Point => {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
};

export interface MouthShape {
  /** Mouth width (corner to corner along the eye line) over the distance
   *  between the eye centres. A smile widens the mouth. */
  width: number;
  /** Height of the mouth corners above the middle of the lips, across the
   *  eye line, over the mouth width. Positive: corners raised. */
  lift: number;
}

/**
 * Raw mouth shape in the face's own frame, independent of point order.
 *
 * The eye line gives the face's horizontal axis, so a tilted head neither
 * widens nor lifts the mouth. The corners are the two mouth points furthest
 * apart along that axis; "middle of the lips" is the centroid of all mouth
 * points. Returns null for degenerate input.
 */
export function mouthShape(mouth: Point[], eyeA: Point, eyeB: Point): MouthShape | null {
  if (mouth.length < 4) return null;
  // Point the axis to the image's right so "down" is +v on an upright face.
  const [left, right] = eyeA[0] <= eyeB[0] ? [eyeA, eyeB] : [eyeB, eyeA];
  const interocular = dist(left, right);
  if (!(interocular > 1e-6)) return null;
  const ux = (right[0] - left[0]) / interocular;
  const uy = (right[1] - left[1]) / interocular;
  const [cx, cy] = centroid(mouth);
  let minU = Infinity;
  let maxU = -Infinity;
  let vAtMin = 0;
  let vAtMax = 0;
  for (const [x, y] of mouth) {
    const dx = x - cx;
    const dy = y - cy;
    const u = dx * ux + dy * uy;
    const v = -dx * uy + dy * ux;
    if (u < minU) {
      minU = u;
      vAtMin = v;
    }
    if (u > maxU) {
      maxU = u;
      vAtMax = v;
    }
  }
  const width = maxU - minU;
  if (!(width > 1e-6)) return null;
  return { width: width / interocular, lift: -(vAtMin + vAtMax) / 2 / width };
}

function mouth106(points: Point[]): MouthShape | null {
  if (points.length !== 106) return null;
  const [a, b] = EYE_RANGES_106.map(([from, to]) => centroid(points.slice(from, to + 1)));
  return mouthShape(points.slice(MOUTH_RANGE_106[0], MOUTH_RANGE_106[1] + 1), a, b);
}

function mouth68(points: Point[]): MouthShape | null {
  if (points.length !== 68) return null;
  const [a, b] = EYES_68.map((eye) => centroid(eye.map((i) => points[i])));
  return mouthShape(points.slice(MOUTH_RANGE_68[0], MOUTH_RANGE_68[1] + 1), a, b);
}

export interface FaceEyeMeasurement {
  /** Normalised landmarks for `faces.landmarks`, or null when the service
   *  returned none (an older service build). */
  landmarks: StoredFaceLandmarks | null;
  /** Openness from the 106-point eye contours; null below the size limit. */
  eyeAspect: number | null;
  /** EAR from the 68-point model; null below the size limit. */
  eyeAspect68: number | null;
  /** `mouthShape` from either model; null below the size limit. */
  mouth: MouthShape | null;
  mouth68: MouthShape | null;
}

/** The ratios alone, for re-measuring landmarks already in the database. */
export type FaceLandmarkRatios = Omit<FaceEyeMeasurement, "landmarks">;

const round4 = (v: number) => Math.round(v * 10000) / 10000;

function normalise(points: Point[] | null, width: number, height: number): Point[] | null {
  if (!points) return null;
  return points.map(([x, y]) => [round4(x / width), round4(y / height)]);
}

/**
 * Everything the face scan stores about one face's landmarks.
 *
 * The ratios are computed on pixel coordinates — normalising x and y by
 * different image sides first would stretch every eye on a non-square photo.
 */
export function measureFaceEyes(
  raw: RawFaceLandmarks,
  faceWidthPx: number,
  imageWidth: number,
  imageHeight: number,
): FaceEyeMeasurement {
  const kps = asPoints(raw.kps, 5);
  const lm106 = asPoints(raw.landmark_2d_106, 106);
  const lm68 = asPoints(raw.landmark_3d_68, 68);
  const sizeOk = imageWidth > 0 && imageHeight > 0;
  const landmarks =
    sizeOk && (kps || lm106 || lm68)
      ? {
          kps: normalise(kps, imageWidth, imageHeight),
          lm106: normalise(lm106, imageWidth, imageHeight),
          lm68: normalise(lm68, imageWidth, imageHeight),
        }
      : null;
  return { landmarks, ...ratiosFromPixels(lm106, lm68, faceWidthPx) };
}

const roundShape = (m: MouthShape | null): MouthShape | null =>
  m == null ? null : { width: round4(m.width), lift: round4(m.lift) };

function ratiosFromPixels(
  lm106: Point[] | null,
  lm68: Point[] | null,
  faceWidthPx: number,
): FaceLandmarkRatios {
  const measurable = faceWidthPx >= MIN_EYE_FACE_PIXELS;
  const r106 = measurable && lm106 ? eyeAspect106(lm106) : null;
  const r68 = measurable && lm68 ? eyeAspect68(lm68) : null;
  return {
    eyeAspect: r106 == null ? null : round4(r106),
    eyeAspect68: r68 == null ? null : round4(r68),
    mouth: roundShape(measurable && lm106 ? mouth106(lm106) : null),
    mouth68: roundShape(measurable && lm68 ? mouth68(lm68) : null),
  };
}

/**
 * Re-measure from `faces.landmarks` without running the detector again —
 * for ratios added after a face already had its landmarks stored.
 * `imageWidth`/`imageHeight` must be the detector's image size, which the
 * scan writes to `photos.width`/`height`. The stored coordinates are rounded
 * to four decimals, a few hundredths of a pixel on a 12 MP photo.
 */
export function ratiosFromStored(
  stored: StoredFaceLandmarks,
  bbox: FaceBBox,
  imageWidth: number,
  imageHeight: number,
): FaceLandmarkRatios | null {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null;
  const toPixels = (pts: Point[] | null) =>
    pts ? pts.map(([x, y]) => [x * imageWidth, y * imageHeight] as Point) : null;
  return ratiosFromPixels(
    toPixels(asPoints(stored.lm106, 106)),
    toPixels(asPoints(stored.lm68, 68)),
    bbox.width * imageWidth,
  );
}

/** Intersection over union of two normalised boxes. */
export function bboxIoU(a: FaceBBox, b: FaceBBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** Overlap a re-detection must reach to count as the same face. The detector
 *  is deterministic on the same file, so real matches sit near 1.0. */
export const MATCH_MIN_IOU = 0.5;

/**
 * Pair stored faces with a fresh detection of the same photo, greedily by
 * best overlap. Returns, for every stored face, the index of its detection or
 * null.
 *
 * The backfill needs this because re-detecting must not replace face rows:
 * person assignments and "ignored" flags hang off `faces.id`.
 */
export function matchDetections(
  stored: Array<FaceBBox | null>,
  detected: FaceBBox[],
  minIoU = MATCH_MIN_IOU,
): Array<number | null> {
  const pairs: Array<{ s: number; d: number; iou: number }> = [];
  stored.forEach((s, si) => {
    if (!s) return;
    detected.forEach((d, di) => {
      const iou = bboxIoU(s, d);
      if (iou >= minIoU) pairs.push({ s: si, d: di, iou });
    });
  });
  pairs.sort((a, b) => b.iou - a.iou);
  const result: Array<number | null> = stored.map(() => null);
  const usedDetections = new Set<number>();
  for (const p of pairs) {
    if (result[p.s] != null || usedDetections.has(p.d)) continue;
    result[p.s] = p.d;
    usedDetections.add(p.d);
  }
  return result;
}

/** The `faces` columns a measurement writes — one place, so the scan, the
 *  backfill and the re-measurement cannot drift apart. */
export function ratioColumns(r: FaceLandmarkRatios) {
  return {
    eye_aspect: r.eyeAspect,
    eye_aspect_68: r.eyeAspect68,
    mouth_width: r.mouth?.width ?? null,
    mouth_lift: r.mouth?.lift ?? null,
    mouth_width_68: r.mouth68?.width ?? null,
    mouth_lift_68: r.mouth68?.lift ?? null,
  };
}
