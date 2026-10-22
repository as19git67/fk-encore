/**
 * Photo collages rendered on the server, for the assistant's
 * `create_photo_collage` (the app's own collage dialog renders in the
 * browser, see frontend/src/components/CollageDialog.vue).
 *
 * The layouts (`collage-layouts.ts`) are the dialog's
 * (`frontend/src/utils/collageLayouts.ts`): same ids, same cells, so a
 * layout the card previews is the one rendered here.
 *
 * One optional caption sits at one of nine places — the four edges, the four
 * corners or the middle — in white bold with a dark outline, like the
 * dialog's text.
 */

import sharp from "sharp";
import { coverCrop } from "./recap-export.service";
import type { CollageLayout } from "./collage-layouts";

export {
  MAX_COLLAGE_PHOTOS,
  MIN_COLLAGE_PHOTOS,
  collageLayouts,
  pickCollageLayout,
  type CollageCell,
  type CollageLayout,
} from "./collage-layouts";

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
