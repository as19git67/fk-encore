/**
 * Photo book: where a photo sits in its cell so the faces on it stay whole.
 * No database, no files — the layout rule (`photo-book-layout.ts`), the
 * service, the preview and the PDF build on these.
 *
 * A cell covers its photo, so the photo loses a strip on one axis (the cut
 * axis). Three steps, in this order:
 *
 *   1. Move the window along the cut axis until every face is inside it,
 *      with a little room above and below a face when there is enough.
 *   2. When the faces are spread wider than the window, zoom out: the photo
 *      shows more along the cut axis and no longer fills its cell on the
 *      other one (a white strip on the paper). Only on framed cells, never
 *      on a full-bleed page or the cover, and never below `MIN_ZOOM`.
 *   3. When even that does not hold all faces, the window goes where it cuts
 *      the least: a face may lose up to a quarter (`MAX_FACE_CUT`); one that
 *      would lose more is better left out entirely than cut through.
 *
 * Faces come from the face scan (`faces.bbox`, shares of the photo), mapped
 * through the owner's edit. A face much smaller than the largest one is
 * somebody in the background and does not steer the window.
 */

export interface FaceRect {
  /** Shares of the photo as printed (after the owner's edit), 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the window over a photo sits: its centre (shares of the photo) and how far it is zoomed out (1 = covers the cell). */
export interface PhotoPlacement {
  cx: number;
  cy: number;
  zoom: number;
}

/** A rectangle as shares of its parent: the part of the photo shown, or the part of the cell it is drawn in. */
export interface ShareRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceFraming {
  /** null: no face steers this photo, it sits as it always did (focal point). */
  placement: PhotoPlacement | null;
  /** The largest share any face loses (0 = all whole, 1 = one is left out). */
  worstCut: number;
  /** What the cuts cost, weighted by face size (0 = all whole); the layout rule adds it to a cell's cost. */
  penalty: number;
}

/** A face may lose at most this share of itself. */
export const MAX_FACE_CUT = 0.25;
/** A zoomed-out photo still fills at least this share of its cell along the other axis. */
export const MIN_ZOOM = 0.8;
/** A face this much narrower than the largest one on the photo is in the background. */
export const BACKGROUND_FACE_RATIO = 0.35;
/** … and so is one under this share of the photo's area (2 % × 2 %). */
export const MIN_FACE_AREA = 0.0004;
/** Room kept around the faces when there is enough, as a share of the largest face. */
const FACE_PAD = 0.15;
/** Along a vertical cut the faces sit a little above the middle of the window. */
const VERTICAL_ANCHOR = 0.42;

const EPS = 1e-6;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

interface WeightedFace extends FaceRect {
  weight: number;
}

/**
 * The faces that steer the window, each with its weight (width relative to
 * the largest face): tiny ones and ones far smaller than the largest drop out.
 */
export function relevantFaces(faces: FaceRect[]): WeightedFace[] {
  const sane = faces
    .map((f) => {
      const x0 = clamp(f.x, 0, 1);
      const y0 = clamp(f.y, 0, 1);
      const x1 = clamp(f.x + f.w, 0, 1);
      const y1 = clamp(f.y + f.h, 0, 1);
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    })
    .filter((f) => f.w > EPS && f.h > EPS && f.w * f.h >= MIN_FACE_AREA);
  if (!sane.length) return [];
  const widest = Math.max(...sane.map((f) => f.w));
  return sane
    .filter((f) => f.w >= widest * BACKGROUND_FACE_RATIO)
    .map((f) => ({ ...f, weight: f.w / widest }));
}

/** The share of the photo the window covers when the photo covers a cell of `cellAspect`. */
export function coverWindow(photoAspect: number, cellAspect: number): { w: number; h: number } {
  if (photoAspect > cellAspect) return { w: cellAspect / photoAspect, h: 1 };
  return { w: 1, h: photoAspect / cellAspect };
}

/**
 * What of a photo a cell shows and where in the cell it is drawn. Without a
 * placement the photo covers the cell around its focal point, the way the
 * book always placed it (CSS `object-position`: the focal point lands at the
 * same share of the cell). With one, the window is centred where it says
 * (kept inside the photo) and a zoomed-out photo is drawn centred, smaller
 * than its cell on one axis.
 */
export function placePhoto(
  photoAspect: number,
  cellAspect: number,
  placement: PhotoPlacement | null,
  focal?: { x: number; y: number } | null,
): { window: ShareRect; inset: ShareRect } {
  const cover = coverWindow(photoAspect, cellAspect);
  if (!placement) {
    const fx = focal && Number.isFinite(focal.x) ? clamp(focal.x, 0, 1) : 0.5;
    const fy = focal && Number.isFinite(focal.y) ? clamp(focal.y, 0, 1) : 0.5;
    return {
      window: { x: (1 - cover.w) * fx, y: (1 - cover.h) * fy, w: cover.w, h: cover.h },
      inset: { x: 0, y: 0, w: 1, h: 1 },
    };
  }
  const zoom = clamp(Number.isFinite(placement.zoom) ? placement.zoom : 1, MIN_ZOOM, 1);
  // Zooming out widens the window along the cut axis only.
  const w = cover.w < 1 - EPS ? Math.min(1, cover.w / zoom) : 1;
  const h = cover.h < 1 - EPS ? Math.min(1, cover.h / zoom) : 1;
  const window = {
    x: clamp(placement.cx - w / 2, 0, 1 - w),
    y: clamp(placement.cy - h / 2, 0, 1 - h),
    w,
    h,
  };
  // The window's shape on paper decides how much of the cell it fills.
  const windowAspect = (w * photoAspect) / h;
  const inset = windowAspect > cellAspect + EPS
    ? { w: 1, h: cellAspect / windowAspect }
    : windowAspect < cellAspect - EPS
      ? { w: windowAspect / cellAspect, h: 1 }
      : { w: 1, h: 1 };
  return { window, inset: { x: (1 - inset.w) / 2, y: (1 - inset.h) / 2, ...inset } };
}

/** The share of a face the window cuts away (0 = whole, 1 = left out). */
export function faceCut(face: FaceRect, window: ShareRect): number {
  const ox = Math.max(0, Math.min(face.x + face.w, window.x + window.w) - Math.max(face.x, window.x));
  const oy = Math.max(0, Math.min(face.y + face.h, window.y + window.h) - Math.max(face.y, window.y));
  const area = face.w * face.h;
  if (area <= 0) return 0;
  const cut = clamp(1 - (ox * oy) / area, 0, 1);
  return cut < 1e-9 ? 0 : cut > 1 - 1e-9 ? 1 : cut;
}

/** What one face's cut costs: a little up to a quarter, a whole face for one left out, more for one cut through. */
function cutCost(cut: number): number {
  if (cut <= MAX_FACE_CUT + EPS) return cut;
  if (cut >= 1 - EPS) return 1;
  return 2 + cut;
}

interface Axis {
  /** Interval of each face along the cut axis. */
  spans: { s: number; e: number; weight: number }[];
}

function scoreAt(spans: Axis["spans"], t: number, len: number): { penalty: number; worst: number } {
  let penalty = 0;
  let total = 0;
  let worst = 0;
  for (const f of spans) {
    const size = f.e - f.s;
    const seen = Math.max(0, Math.min(f.e, t + len) - Math.max(f.s, t));
    const cut = size > 0 ? clamp(1 - seen / size, 0, 1) : 0;
    penalty += f.weight * cutCost(cut);
    total += f.weight;
    worst = Math.max(worst, cut);
  }
  return { penalty: total ? penalty / total : 0, worst };
}

/** Where along the axis the window of length `len` cuts the faces the least. */
function leastCut(spans: Axis["spans"], len: number, preferred: number): { t: number; penalty: number; worst: number } {
  const hi = Math.max(0, 1 - len);
  const candidates = new Set<number>([0, hi, clamp(preferred, 0, hi)]);
  for (const f of spans) {
    const size = f.e - f.s;
    // Edges of the window on the edges of a face, on the quarter marks, and just past it.
    for (const t of [f.s, f.e - len, f.s + MAX_FACE_CUT * size, f.e - MAX_FACE_CUT * size - len, f.e, f.s - len]) {
      candidates.add(clamp(t, 0, hi));
    }
  }
  let best: { t: number; penalty: number; worst: number } | null = null;
  for (const t of candidates) {
    const s = scoreAt(spans, t, len);
    const better = !best
      || s.penalty < best.penalty - EPS
      || (Math.abs(s.penalty - best.penalty) <= EPS && Math.abs(t - preferred) < Math.abs(best.t - preferred) - EPS);
    if (better) best = { t, ...s };
  }
  return best!;
}

/** A window of length `len` that holds [lo, hi], as close to `preferred` as that allows; null when it cannot. */
function holding(lo: number, hi: number, len: number, preferred: number): number | null {
  if (hi - lo > len + EPS) return null;
  const from = Math.max(0, hi - len);
  const to = Math.min(1 - len, lo);
  if (from > to + EPS) return null;
  return clamp(preferred, from, Math.max(from, to));
}

/**
 * Where a photo of `photoAspect` sits in a cell of `cellAspect` so its faces
 * stay whole (see the steps at the top). `canZoom` is false for cells that
 * reach the edge of the sheet (full bleed, the cover): a strip there would
 * show the paper at the trim.
 */
export function frameFaces(photoAspect: number, cellAspect: number, faces: FaceRect[], canZoom: boolean): FaceFraming {
  const relevant = relevantFaces(faces);
  if (!relevant.length || !(photoAspect > 0) || !(cellAspect > 0)) return { placement: null, worstCut: 0, penalty: 0 };
  const cover = coverWindow(photoAspect, cellAspect);
  const horizontal = cover.w < 1 - EPS;
  const vertical = cover.h < 1 - EPS;
  if (!horizontal && !vertical) return { placement: { cx: 0.5, cy: 0.5, zoom: 1 }, worstCut: 0, penalty: 0 };

  const L = horizontal ? cover.w : cover.h;
  const spans = relevant.map((f) => (horizontal ? { s: f.x, e: f.x + f.w, weight: f.weight } : { s: f.y, e: f.y + f.h, weight: f.weight }));
  const u0 = Math.min(...spans.map((s) => s.s));
  const u1 = Math.max(...spans.map((s) => s.e));
  const pad = FACE_PAD * Math.max(...spans.map((s) => s.e - s.s));
  const p0 = clamp(u0 - pad, 0, 1);
  const p1 = clamp(u1 + pad, 0, 1);
  const centre = (u0 + u1) / 2;
  const startFor = (len: number) => (horizontal ? centre - len / 2 : centre - VERTICAL_ANCHOR * len);
  const placementFor = (t: number, len: number, zoom: number): PhotoPlacement => {
    const mid = t + len / 2;
    return horizontal ? { cx: mid, cy: 0.5, zoom } : { cx: 0.5, cy: mid, zoom };
  };
  const whole = (t: number, len: number, zoom: number): FaceFraming => ({ placement: placementFor(t, len, zoom), worstCut: 0, penalty: 0 });

  // 1. Move: the faces with room around them, else the faces alone.
  for (const [lo, hi] of [[p0, p1], [u0, u1]] as const) {
    const t = holding(lo, hi, L, startFor(L));
    if (t != null) return whole(t, L, 1);
  }

  // 2. Zoom out as little as it takes, on framed cells only.
  if (canZoom) {
    for (const [lo, hi] of [[p0, p1], [u0, u1]] as const) {
      const len = Math.min(1, hi - lo);
      const zoom = Math.max(L / len, L);
      if (zoom < MIN_ZOOM - EPS) continue;
      const t = holding(lo, hi, len, startFor(len));
      if (t != null) return whole(t, len, Math.min(1, zoom));
    }
  }

  // 3. Cut as little as possible, never more than a quarter of a face when that can be had.
  let best: FaceFraming | null = null;
  let bestCost = Infinity;
  for (const zoom of canZoom ? [1, MIN_ZOOM] : [1]) {
    const len = Math.min(1, L / zoom);
    const r = leastCut(spans, len, startFor(len));
    // Zooming out costs a little, so it is only taken when it cuts less.
    const cost = r.penalty + (zoom < 1 ? 0.01 : 0);
    if (cost < bestCost - EPS) {
      bestCost = cost;
      best = { placement: placementFor(r.t, len, zoom), worstCut: r.worst, penalty: r.penalty };
    }
  }
  return best!;
}

/** What a cell costs the layout rule for its faces: their cuts, and a little for zooming out. */
export function faceCost(f: FaceFraming): number {
  const zoomedOut = f.placement ? 1 - f.placement.zoom : 0;
  return 0.25 * f.penalty + 0.3 * zoomedOut;
}

/** Whether two windows show visibly different parts of a photo (more than 1 % of it off). */
export function windowsDiffer(a: ShareRect, b: ShareRect): boolean {
  return Math.abs(a.x - b.x) > 0.01 || Math.abs(a.y - b.y) > 0.01 || Math.abs(a.w - b.w) > 0.01 || Math.abs(a.h - b.h) > 0.01;
}
