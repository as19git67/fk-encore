/**
 * Photo collages rendered on the server, for the assistant's
 * `create_photo_collage` (the app's own collage dialog renders in the
 * browser, see frontend/src/components/CollageDialog.vue).
 *
 * The layout table is the dialog's (`frontend/src/utils/collageLayouts.ts`):
 * same ids, same cells, so a layout the card previews is the one rendered
 * here. `collage.test.ts` holds both tables against each other.
 *
 * One optional caption sits at one of nine places — the four edges, the four
 * corners or the middle — in white bold with a dark outline, like the
 * dialog's text.
 */

import sharp from "sharp";
import { coverCrop } from "./recap-export.service";

export interface CollageCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CollageLayout {
  id: string;
  name: string;
  /** Width / height. */
  aspect: number;
  cells: CollageCell[];
}

const FULL: CollageCell = { x: 0, y: 0, w: 1, h: 1 };

function cell(x: number, y: number, w: number, h: number): CollageCell {
  return { x, y, w, h };
}

function gridCells(cols: number, rows: number, region: CollageCell = FULL): CollageCell[] {
  const cw = region.w / cols;
  const ch = region.h / rows;
  const out: CollageCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out.push(cell(region.x + c * cw, region.y + r * ch, cw, ch));
  }
  return out;
}

function rowBands(counts: number[], region: CollageCell = FULL): CollageCell[] {
  const ch = region.h / counts.length;
  const out: CollageCell[] = [];
  counts.forEach((n, r) => {
    const cw = region.w / n;
    for (let c = 0; c < n; c++) out.push(cell(region.x + c * cw, region.y + r * ch, cw, ch));
  });
  return out;
}

function colBands(counts: number[], region: CollageCell = FULL): CollageCell[] {
  const cw = region.w / counts.length;
  const out: CollageCell[] = [];
  counts.forEach((n, c) => {
    const ch = region.h / n;
    for (let r = 0; r < n; r++) out.push(cell(region.x + c * cw, region.y + r * ch, cw, ch));
  });
  return out;
}

function heroLeft(heroW: number, restRows: number[]): CollageCell[] {
  return [cell(0, 0, heroW, 1), ...rowBands(restRows, { x: heroW, y: 0, w: 1 - heroW, h: 1 })];
}

const LAYOUTS: Record<number, CollageLayout[]> = {
  2: [
    { id: "side", name: "Nebeneinander", aspect: 3 / 2, cells: rowBands([2]) },
    { id: "stack", name: "Übereinander", aspect: 3 / 4, cells: colBands([2]) },
    { id: "big-left", name: "Groß + Klein", aspect: 3 / 2, cells: [cell(0, 0, 0.62, 1), cell(0.62, 0, 0.38, 1)] },
  ],
  3: [
    { id: "cols", name: "Spalten", aspect: 3 / 2, cells: rowBands([3]) },
    { id: "hero-left", name: "Held links", aspect: 3 / 2, cells: heroLeft(0.6, [1, 1]) },
    { id: "hero-top", name: "Held oben", aspect: 1, cells: [cell(0, 0, 1, 0.6), cell(0, 0.6, 0.5, 0.4), cell(0.5, 0.6, 0.5, 0.4)] },
  ],
  4: [
    { id: "grid", name: "Raster 2×2", aspect: 1, cells: gridCells(2, 2) },
    { id: "cols", name: "Spalten", aspect: 16 / 9, cells: rowBands([4]) },
    { id: "hero-left", name: "Held links", aspect: 3 / 2, cells: heroLeft(0.6, [1, 1, 1]) },
  ],
  5: [
    { id: "hero-left", name: "Held links", aspect: 3 / 2, cells: [cell(0, 0, 0.6, 1), ...gridCells(2, 2, { x: 0.6, y: 0, w: 0.4, h: 1 })] },
    { id: "two-three", name: "2 / 3", aspect: 3 / 2, cells: rowBands([2, 3]) },
    { id: "three-two", name: "3 / 2", aspect: 3 / 2, cells: rowBands([3, 2]) },
  ],
  6: [
    { id: "grid-3x2", name: "Raster 3×2", aspect: 3 / 2, cells: gridCells(3, 2) },
    { id: "grid-2x3", name: "Raster 2×3", aspect: 2 / 3, cells: gridCells(2, 3) },
    { id: "two-four", name: "2 groß / 4", aspect: 3 / 2, cells: rowBands([2, 4]) },
  ],
  7: [
    { id: "three-four", name: "3 / 4", aspect: 3 / 2, cells: rowBands([3, 4]) },
    { id: "hero-left", name: "Held links", aspect: 3 / 2, cells: [cell(0, 0, 0.5, 1), ...gridCells(2, 3, { x: 0.5, y: 0, w: 0.5, h: 1 })] },
    { id: "four-three", name: "4 / 3", aspect: 3 / 2, cells: rowBands([4, 3]) },
  ],
  8: [
    { id: "grid-4x2", name: "Raster 4×2", aspect: 16 / 9, cells: gridCells(4, 2) },
    { id: "grid-2x4", name: "Raster 2×4", aspect: 9 / 16, cells: gridCells(2, 4) },
    { id: "three-two-three", name: "3 / 2 / 3", aspect: 1, cells: rowBands([3, 2, 3]) },
  ],
  9: [
    { id: "grid-3x3", name: "Raster 3×3", aspect: 1, cells: gridCells(3, 3) },
    { id: "hero-left", name: "Held links", aspect: 3 / 2, cells: [cell(0, 0, 0.5, 1), ...gridCells(2, 4, { x: 0.5, y: 0, w: 0.5, h: 1 })] },
    { id: "two-three-four", name: "2 / 3 / 4", aspect: 3 / 2, cells: rowBands([2, 3, 4]) },
  ],
};

export const MIN_COLLAGE_PHOTOS = 2;
export const MAX_COLLAGE_PHOTOS = 9;

export function collageLayouts(count: number): CollageLayout[] {
  return LAYOUTS[count] ?? [];
}

/** The layout `id` for `count` photos, the first variant when none is named; undefined for an unknown id. */
export function pickCollageLayout(count: number, id?: string | null): CollageLayout | undefined {
  const all = collageLayouts(count);
  return id ? all.find((l) => l.id === id) : all[0];
}

// ── caption ─────────────────────────────────────────────────────────────

// A plain union: Encore's schema parser reads the endpoint types literally.
export type CollageTextPosition =
  | "center" | "top" | "bottom" | "left" | "right"
  | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const COLLAGE_TEXT_POSITIONS: readonly CollageTextPosition[] = [
  "center", "top", "bottom", "left", "right",
  "top-left", "top-right", "bottom-left", "bottom-right",
];

export const COLLAGE_TEXT_POSITION_LABELS: Record<CollageTextPosition, string> = {
  center: "Mitte",
  top: "oben",
  bottom: "unten",
  left: "links",
  right: "rechts",
  "top-left": "oben links",
  "top-right": "oben rechts",
  "bottom-left": "unten links",
  "bottom-right": "unten rechts",
};

export type CollageTextSize = "small" | "medium" | "large";

/** Font size as a fraction of the collage height — the dialog's presets. */
export const COLLAGE_TEXT_SIZES: Record<CollageTextSize, number> = {
  small: 0.05,
  medium: 0.08,
  large: 0.13,
};

export interface CollageText {
  text: string;
  position: CollageTextPosition;
  size: CollageTextSize;
  /** `#rrggbb`. */
  color: string;
}

/** Distance of the caption from the edges, as a fraction of each side. */
const TEXT_MARGIN = 0.05;
const LINE_HEIGHT = 1.25;
/** Average advance of a bold sans-serif glyph, in em; SVG text cannot be measured here. */
const GLYPH_EM = 0.58;

export function isTextPosition(v: unknown): v is CollageTextPosition {
  return typeof v === "string" && (COLLAGE_TEXT_POSITIONS as readonly string[]).includes(v);
}

/**
 * Where a position puts the caption: the horizontal alignment and which
 * edge (or the middle) the text block hangs from. "left" alone is the left
 * edge at mid height; "top" alone is centred at the top.
 */
export function textPlacement(position: CollageTextPosition): { align: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom" } {
  const parts = position.split("-");
  const align = parts.includes("left") ? "left" : parts.includes("right") ? "right" : "center";
  const vertical = parts.includes("top") ? "top" : parts.includes("bottom") ? "bottom" : "middle";
  return { align, vertical };
}

/** Greedy word wrap by estimated width; explicit newlines always break. */
export function wrapCaption(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && candidate.length > maxChars) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The caption as an SVG the size of the collage, transparent around the text. */
export function captionSvg(width: number, height: number, caption: CollageText): string {
  const fontPx = Math.round(COLLAGE_TEXT_SIZES[caption.size] * height);
  const maxWidth = width * (1 - 2 * TEXT_MARGIN);
  const lines = wrapCaption(caption.text.trim(), Math.max(1, Math.floor(maxWidth / (fontPx * GLYPH_EM))));
  const { align, vertical } = textPlacement(caption.position);
  const lineHeight = fontPx * LINE_HEIGHT;
  const block = lineHeight * lines.length;
  const top = vertical === "top"
    ? height * TEXT_MARGIN
    : vertical === "bottom"
      ? height * (1 - TEXT_MARGIN) - block
      : (height - block) / 2;
  const x = align === "left" ? width * TEXT_MARGIN : align === "right" ? width * (1 - TEXT_MARGIN) : width / 2;
  const anchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
  const stroke = Math.max(2, Math.round(fontPx * 0.08));
  const texts = lines.map((line, i) => line
    ? `<text x="${x.toFixed(1)}" y="${(top + i * lineHeight + fontPx * 0.95).toFixed(1)}">${escapeXml(line)}</text>`
    : "").join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<g font-family="Noto Sans, DejaVu Sans, sans-serif" font-weight="700" font-size="${fontPx}" text-anchor="${anchor}"`
    + ` fill="${caption.color}" stroke="rgba(0,0,0,0.7)" stroke-width="${stroke}" stroke-linejoin="round" paint-order="stroke">`
    + `${texts}</g></svg>`;
}

// ── rendering ───────────────────────────────────────────────────────────

/** Long edge of the JPEG, as in the dialog's export. */
export const COLLAGE_LONG_EDGE = 4000;
const GAP_FRACTION = 0.006;

export interface CollageSource {
  /** A path or a decoded image (HEIC is converted by the caller). */
  input: string | Buffer;
  focal?: { x: number; y: number } | null;
}

export function collageSize(aspect: number, longEdge = COLLAGE_LONG_EDGE): { width: number; height: number } {
  return aspect >= 1
    ? { width: longEdge, height: Math.round(longEdge / aspect) }
    : { width: Math.round(longEdge * aspect), height: longEdge };
}

/**
 * The collage as a JPEG: each source cover-cropped into its cell around its
 * focal point, a thin white gap between the cells, the caption on top.
 * `sources[i]` fills `layout.cells[i]`.
 */
export async function renderCollage(
  layout: CollageLayout,
  sources: CollageSource[],
  caption: CollageText | null,
  longEdge = COLLAGE_LONG_EDGE,
): Promise<Buffer> {
  if (sources.length !== layout.cells.length) {
    throw new Error(`layout ${layout.id} has ${layout.cells.length} cells, got ${sources.length} photos`);
  }
  const { width, height } = collageSize(layout.aspect, longEdge);
  const gap = Math.round(longEdge * GAP_FRACTION);
  const tiles: Array<{ input: Buffer; left: number; top: number; raw?: { width: number; height: number; channels: 1 | 2 | 3 | 4 } }> = [];
  for (let i = 0; i < sources.length; i++) {
    const c = layout.cells[i];
    const left = Math.round(c.x * width + gap / 2);
    const top = Math.round(c.y * height + gap / 2);
    const w = Math.round(c.w * width - gap);
    const h = Math.round(c.h * height - gap);
    if (w <= 0 || h <= 0) continue;
    // Decode once with the EXIF orientation applied, so the crop works on
    // the picture as it is seen.
    const { data, info } = await sharp(sources[i].input).rotate().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const crop = coverCrop(info.width, info.height, w / h, sources[i].focal);
    // Two roundings can overshoot the edge by a pixel; extract refuses that.
    crop.width = Math.max(1, Math.min(crop.width, info.width - crop.left));
    crop.height = Math.max(1, Math.min(crop.height, info.height - crop.top));
    const tile = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .extract(crop)
      .resize(w, h)
      .raw()
      .toBuffer();
    tiles.push({ input: tile, raw: { width: w, height: h, channels: info.channels }, left, top });
  }
  if (caption && caption.text.trim()) {
    tiles.push({ input: Buffer.from(captionSvg(width, height, caption)), left: 0, top: 0 });
  }
  return sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite(tiles)
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * The capture time a collage gets: one second after the newest source, so it
 * sorts right after the photos it was made from — the dialog does the same.
 */
export function collageTakenAt(takenAts: Array<string | null | undefined>): string | null {
  const dates = takenAts.filter((d): d is string => !!d).sort();
  const newest = dates[dates.length - 1];
  const m = newest?.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0));
  dt.setUTCSeconds(dt.getUTCSeconds() + 1);
  return dt.toISOString();
}
