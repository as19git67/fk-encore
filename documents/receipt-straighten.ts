/**
 * Perspective-corrects a receipt photo so that the document fills the frame.
 *
 * Algorithm:
 *   1. Downscale to 400 px for fast edge detection
 *   2. Grayscale + 3×3 Gaussian blur
 *   3. Sobel edge magnitude
 *   4. For each side (top/bottom/left/right) collect the outermost strong-edge
 *      pixel per scan line and fit a line through those points
 *   5. Compute the 4 corners as line intersections
 *   6. Apply inverse-mapped bilinear interpolation via the `perspective-transform`
 *      homography package
 *
 * Returns the original buffer unchanged when corner detection fails or the
 * detected quad is implausibly small / large.
 */

import sharp from "sharp";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PerspT: (src: number[], dst: number[]) => { transformInverse(x: number, y: number): number[] } =
  _require("perspective-transform");

const DETECT_SIZE = 400;
const MAX_OUT_DIM = 1600;
const MIN_COVERAGE = 0.15; // quad area must be ≥15 % of the detection frame

type Point = [number, number];
type Line = { a: number; b: number };

export async function straightenReceipt(input: Buffer): Promise<Buffer> {
  try {
    return await _straighten(input);
  } catch {
    return input;
  }
}

async function _straighten(input: Buffer): Promise<Buffer> {
  const meta = await sharp(input, { failOn: "none" }).metadata();
  const srcW = meta.width ?? 1000;
  const srcH = meta.height ?? 1000;

  const sc = Math.min(DETECT_SIZE / srcW, DETECT_SIZE / srcH, 1);
  const dw = Math.max(1, Math.round(srcW * sc));
  const dh = Math.max(1, Math.round(srcH * sc));

  const raw = await sharp(input, { failOn: "none" })
    .resize(dw, dh)
    .grayscale()
    .raw()
    .toBuffer();

  const gray = new Uint8Array(raw);
  const blurred = blur3(gray, dw, dh);
  const edges = sobel(blurred, dw, dh);
  const thresh = edgeThreshold(edges);

  // Outermost strong-edge point per scan line, for each side
  const topPts: Point[] = [];
  const botPts: Point[] = [];
  const leftPts: Point[] = [];
  const rightPts: Point[] = [];

  for (let x = 2; x < dw - 2; x++) {
    for (let y = 2; y < Math.ceil(dh / 2); y++) {
      if (edges[y * dw + x] >= thresh) { topPts.push([x, y]); break; }
    }
    for (let y = dh - 3; y >= Math.floor(dh / 2); y--) {
      if (edges[y * dw + x] >= thresh) { botPts.push([x, y]); break; }
    }
  }
  for (let y = 2; y < dh - 2; y++) {
    for (let x = 2; x < Math.ceil(dw / 2); x++) {
      if (edges[y * dw + x] >= thresh) { leftPts.push([x, y]); break; }
    }
    for (let x = dw - 3; x >= Math.floor(dw / 2); x--) {
      if (edges[y * dw + x] >= thresh) { rightPts.push([x, y]); break; }
    }
  }

  const topL = fitHoriz(topPts);   // y = a·x + b
  const botL = fitHoriz(botPts);
  const leftL = fitVert(leftPts);  // x = a·y + b
  const rightL = fitVert(rightPts);

  if (!topL || !botL || !leftL || !rightL) return input;

  const tl = intersectVH(leftL, topL);
  const tr = intersectVH(rightL, topL);
  const br = intersectVH(rightL, botL);
  const bl = intersectVH(leftL, botL);

  const area = shoelace([tl, tr, br, bl]);
  if (area < dw * dh * MIN_COVERAGE || area > dw * dh * 1.1) return input;

  const inv = 1 / sc;
  const S = (p: Point): Point => [clamp(p[0] * inv, 0, srcW - 1), clamp(p[1] * inv, 0, srcH - 1)];
  const sTL = S(tl), sTR = S(tr), sBR = S(br), sBL = S(bl);

  const outW = Math.min(MAX_OUT_DIM, Math.round((dist(sTL, sTR) + dist(sBL, sBR)) / 2));
  const outH = Math.min(MAX_OUT_DIM, Math.round((dist(sTL, sBL) + dist(sTR, sBR)) / 2));
  if (outW < 50 || outH < 50) return input;

  // Inverse-map via homography
  const xform = PerspT(
    [sTL[0], sTL[1], sTR[0], sTR[1], sBR[0], sBR[1], sBL[0], sBL[1]],
    [0, 0, outW, 0, outW, outH, 0, outH],
  );

  const { data: srcData, info } = await sharp(input, { failOn: "none" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const srcPx = new Uint8Array(srcData);
  const ch = info.channels as 1 | 2 | 3 | 4;

  const outPx = new Uint8Array(outW * outH * ch);
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const [sx, sy] = xform.transformInverse(ox + 0.5, oy + 0.5);
      bilinear(srcPx, srcW, srcH, ch, sx, sy, outPx, (oy * outW + ox) * ch);
    }
  }

  return sharp(outPx, { raw: { width: outW, height: outH, channels: ch } })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

// ── image processing ──────────────────────────────────────────────────────────

function blur3(src: Uint8Array, w: number, h: number): Uint8Array {
  const K = [1, 2, 1, 2, 4, 2, 1, 2, 1]; // 3×3 Gaussian, sum=16
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          s += src[(y + dy) * w + (x + dx)] * K[k++];
      out[y * w + x] = s >> 4;
    }
  }
  return out;
}

function sobel(src: Uint8Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = src[(y-1)*w+(x-1)], tc = src[(y-1)*w+x], tr = src[(y-1)*w+(x+1)];
      const ml = src[y*w+(x-1)],                           mr = src[y*w+(x+1)];
      const bl = src[(y+1)*w+(x-1)], bc = src[(y+1)*w+x], br = src[(y+1)*w+(x+1)];
      const gx = -tl - 2*ml - bl + tr + 2*mr + br;
      const gy = -tl - 2*tc - tr + bl + 2*bc + br;
      out[y * w + x] = Math.sqrt(gx*gx + gy*gy);
    }
  }
  return out;
}

function edgeThreshold(edges: Float32Array): number {
  const vals: number[] = [];
  for (let i = 0; i < edges.length; i++) if (edges[i] > 0) vals.push(edges[i]);
  if (vals.length === 0) return Infinity;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.80)]; // 80th percentile
}

function bilinear(
  src: Uint8Array, sw: number, sh: number, ch: number,
  sx: number, sy: number,
  dst: Uint8Array, dstOff: number,
): void {
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const x1 = x0 + 1, y1 = y0 + 1;
  const fx = sx - x0, fy = sy - y0;
  const cx = 1 - fx, cy = 1 - fy;
  for (let c = 0; c < ch; c++) {
    const p00 = src[(clamp(y0,0,sh-1)*sw + clamp(x0,0,sw-1))*ch + c];
    const p10 = src[(clamp(y0,0,sh-1)*sw + clamp(x1,0,sw-1))*ch + c];
    const p01 = src[(clamp(y1,0,sh-1)*sw + clamp(x0,0,sw-1))*ch + c];
    const p11 = src[(clamp(y1,0,sh-1)*sw + clamp(x1,0,sw-1))*ch + c];
    dst[dstOff + c] = Math.round(cy*(cx*p00 + fx*p10) + fy*(cx*p01 + fx*p11));
  }
}

// ── line fitting ──────────────────────────────────────────────────────────────

function fitHoriz(pts: Point[]): Line | null {
  if (pts.length < 10) return null;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  const n = pts.length;
  for (const [x, y] of pts) { sumX += x; sumY += y; sumXX += x*x; sumXY += x*y; }
  const d = n*sumXX - sumX*sumX;
  if (Math.abs(d) < 1e-6) return null;
  const a = (n*sumXY - sumX*sumY) / d;
  return { a, b: (sumY - a*sumX) / n };
}

function fitVert(pts: Point[]): Line | null {
  if (pts.length < 10) return null;
  let sumX = 0, sumY = 0, sumYY = 0, sumXY = 0;
  const n = pts.length;
  for (const [x, y] of pts) { sumX += x; sumY += y; sumYY += y*y; sumXY += x*y; }
  const d = n*sumYY - sumY*sumY;
  if (Math.abs(d) < 1e-6) return null;
  const a = (n*sumXY - sumY*sumX) / d;
  return { a, b: (sumX - a*sumY) / n };
}

// ── geometry ──────────────────────────────────────────────────────────────────

function intersectVH(vert: Line, horiz: Line): Point {
  // x = av·y + bv  and  y = ah·x + bh
  // → y(1 − av·ah) = ah·bv + bh
  const d = 1 - vert.a * horiz.a;
  if (Math.abs(d) < 1e-9) return [vert.b, horiz.b];
  const y = (horiz.a * vert.b + horiz.b) / d;
  return [vert.a * y + vert.b, y];
}

function shoelace(pts: Point[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return Math.abs(area) / 2;
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
