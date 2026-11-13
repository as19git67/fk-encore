/**
 * Photo book (documentation/plans/fotobuch.md, issue #1729): formats, page
 * layouts, chapters and the rule-based page builder. No database, no files —
 * the service (`photo-book.service.ts`) and the PDF (`photo-book-pdf.ts`)
 * build on these, the tests exercise them directly.
 */

// ── formats ─────────────────────────────────────────────────────────────

// A plain union: Encore's schema parser reads the endpoint types literally.
export type PhotoBookFormat = "a4-landscape" | "a4-portrait" | "square-21" | "square-30";

export interface PhotoBookFormatInfo {
  id: PhotoBookFormat;
  name: string;
  /** Trim size in mm. */
  width: number;
  height: number;
}

export const PHOTO_BOOK_FORMATS: Record<PhotoBookFormat, PhotoBookFormatInfo> = {
  "a4-landscape": { id: "a4-landscape", name: "A4 quer", width: 297, height: 210 },
  "a4-portrait": { id: "a4-portrait", name: "A4 hoch", width: 210, height: 297 },
  "square-21": { id: "square-21", name: "Quadrat 21 × 21 cm", width: 210, height: 210 },
  "square-30": { id: "square-30", name: "Quadrat 30 × 30 cm", width: 300, height: 300 },
};

export function isPhotoBookFormat(v: unknown): v is PhotoBookFormat {
  return typeof v === "string" && v in PHOTO_BOOK_FORMATS;
}

/** White border around the content box of a framed page, in mm. */
export const PAGE_MARGIN_MM = 12;
/** Space between two photos on a page, in mm. */
export const CELL_GAP_MM = 4;
/** Below this a slot prints visibly soft; the editor warns. */
export const MIN_PRINT_DPI = 200;
/** Photos are rendered at this resolution at most. */
export const RENDER_DPI = 300;

// ── layouts ─────────────────────────────────────────────────────────────

export interface BookCell {
  /** Normalised to the page's content box (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PageKind = "opener" | "photos";

export interface BookLayout {
  id: string;
  name: string;
  kind: PageKind;
  cells: BookCell[];
  /** The single cell covers the whole page including the bleed. */
  fullBleed?: boolean;
  /** Chapter openers: where title and subtitle go, in the content box. */
  text?: BookCell;
}

function cell(x: number, y: number, w: number, h: number): BookCell {
  return { x, y, w, h };
}

const FULL: BookCell = cell(0, 0, 1, 1);

export const OPENER_LAYOUT: BookLayout = {
  id: "opener",
  name: "Kapitelanfang",
  kind: "opener",
  text: cell(0, 0, 1, 0.2),
  cells: [cell(0, 0.22, 1, 0.78)],
};

/** A chapter opener whose photo was taken out of the book: the title alone. */
export const OPENER_TEXT_LAYOUT: BookLayout = {
  id: "opener-text",
  name: "Kapitelanfang ohne Foto",
  kind: "opener",
  text: cell(0, 0.35, 1, 0.3),
  cells: [],
};

const PHOTO_LAYOUTS: Record<number, BookLayout[]> = {
  1: [
    { id: "full", name: "Randlos", kind: "photos", cells: [FULL], fullBleed: true },
    { id: "single", name: "Mit Rand", kind: "photos", cells: [FULL] },
  ],
  2: [
    { id: "side", name: "Nebeneinander", kind: "photos", cells: [cell(0, 0, 0.5, 1), cell(0.5, 0, 0.5, 1)] },
    { id: "stack", name: "Übereinander", kind: "photos", cells: [cell(0, 0, 1, 0.5), cell(0, 0.5, 1, 0.5)] },
    { id: "big-small", name: "Groß + Klein", kind: "photos", cells: [cell(0, 0, 0.62, 1), cell(0.62, 0, 0.38, 1)] },
  ],
  3: [
    { id: "cols", name: "Spalten", kind: "photos", cells: [cell(0, 0, 1 / 3, 1), cell(1 / 3, 0, 1 / 3, 1), cell(2 / 3, 0, 1 / 3, 1)] },
    { id: "hero-left", name: "Groß links", kind: "photos", cells: [cell(0, 0, 0.6, 1), cell(0.6, 0, 0.4, 0.5), cell(0.6, 0.5, 0.4, 0.5)] },
    { id: "hero-top", name: "Groß oben", kind: "photos", cells: [cell(0, 0, 1, 0.6), cell(0, 0.6, 0.5, 0.4), cell(0.5, 0.6, 0.5, 0.4)] },
  ],
  4: [
    { id: "grid", name: "Raster 2 × 2", kind: "photos", cells: [cell(0, 0, 0.5, 0.5), cell(0.5, 0, 0.5, 0.5), cell(0, 0.5, 0.5, 0.5), cell(0.5, 0.5, 0.5, 0.5)] },
    { id: "hero-left", name: "Groß links", kind: "photos", cells: [cell(0, 0, 0.6, 1), cell(0.6, 0, 0.4, 1 / 3), cell(0.6, 1 / 3, 0.4, 1 / 3), cell(0.6, 2 / 3, 0.4, 1 / 3)] },
    { id: "hero-top", name: "Groß oben", kind: "photos", cells: [cell(0, 0, 1, 0.6), cell(0, 0.6, 1 / 3, 0.4), cell(1 / 3, 0.6, 1 / 3, 0.4), cell(2 / 3, 0.6, 1 / 3, 0.4)] },
  ],
};

export const MAX_PHOTOS_PER_PAGE = 4;

/** The layouts for a page holding `count` photos (openers have one of their own). */
export function bookLayouts(kind: PageKind, count: number): BookLayout[] {
  if (kind === "opener") return count === 1 ? [OPENER_LAYOUT] : count === 0 ? [OPENER_TEXT_LAYOUT] : [];
  return PHOTO_LAYOUTS[count] ?? [];
}

export function findBookLayout(kind: PageKind, count: number, id: string): BookLayout | undefined {
  return bookLayouts(kind, count).find((l) => l.id === id);
}

// ── geometry ────────────────────────────────────────────────────────────

export interface RectMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The content box of a framed page, relative to the trim box. */
export function contentBox(format: PhotoBookFormat): RectMm {
  const f = PHOTO_BOOK_FORMATS[format];
  return { x: PAGE_MARGIN_MM, y: PAGE_MARGIN_MM, w: f.width - 2 * PAGE_MARGIN_MM, h: f.height - 2 * PAGE_MARGIN_MM };
}

/**
 * A cell in mm, relative to the trim box. The content box is widened by half
 * a gap on every side and each cell inset by half a gap, so neighbours keep
 * one gap between them and outer edges stay on the content box.
 */
export function cellRect(format: PhotoBookFormat, layout: BookLayout, c: BookCell): RectMm {
  const f = PHOTO_BOOK_FORMATS[format];
  if (layout.fullBleed) return { x: 0, y: 0, w: f.width, h: f.height };
  const box = contentBox(format);
  const g = CELL_GAP_MM;
  const W = box.w + g;
  const H = box.h + g;
  return {
    x: box.x - g / 2 + c.x * W + g / 2,
    y: box.y - g / 2 + c.y * H + g / 2,
    w: Math.max(1, c.w * W - g),
    h: Math.max(1, c.h * H - g),
  };
}

export function textRect(format: PhotoBookFormat, layout: BookLayout): RectMm | null {
  if (!layout.text) return null;
  const box = contentBox(format);
  const t = layout.text;
  return { x: box.x + t.x * box.w, y: box.y + t.y * box.h, w: t.w * box.w, h: t.h * box.h };
}

/** Height of the strip under a framed photo that holds its caption (stage 2). */
export const CAPTION_STRIP_MM = 8;
/** Space between a photo and its caption, taken from the strip. */
const CAPTION_GAP_MM = 1.2;

/** Font size of a caption (pt): the largest, and the smallest it shrinks to before it is cut. */
export const CAPTION_MAX_PT = 8;
export const CAPTION_MIN_PT = 5;
/** Distance of a caption's lines, as a multiple of its size. */
export const CAPTION_LINE_HEIGHT = 1.2;

/**
 * The largest caption size between `CAPTION_MAX_PT` and `CAPTION_MIN_PT` at
 * which the text fits `heightPt`; `heightAt` measures the wrapped text at a
 * size. A strip of two lines at the largest size holds three at a smaller one,
 * so a long caption shrinks before it loses its end.
 */
export function fitCaptionSize(heightPt: number, heightAt: (sizePt: number) => number): number {
  for (let size = CAPTION_MAX_PT; size > CAPTION_MIN_PT; size -= 0.25) {
    if (heightAt(size) <= heightPt) return size;
  }
  return CAPTION_MIN_PT;
}

export interface SlotGeometry {
  /** Where the photo goes. */
  image: RectMm;
  /** Where its caption goes; null when the page shows no captions. */
  caption: RectMm | null;
  /** The caption lies over the photo (full bleed), not under it. */
  overlay: boolean;
}

/**
 * A cell split into photo and caption. On a framed page the caption takes a
 * strip at the bottom of the cell, so every photo on a captioned page loses
 * the same height and the page stays even. A full-bleed photo has no frame to
 * put it in: the caption lies over the photo, inside the page margin, where
 * the trim cannot cut it.
 */
export function slotGeometry(format: PhotoBookFormat, layout: BookLayout, c: BookCell, captioned: boolean): SlotGeometry {
  const r = cellRect(format, layout, c);
  if (!captioned) return { image: r, caption: null, overlay: false };
  if (layout.fullBleed) {
    const f = PHOTO_BOOK_FORMATS[format];
    return {
      image: r,
      caption: { x: PAGE_MARGIN_MM, y: f.height - PAGE_MARGIN_MM - CAPTION_STRIP_MM, w: f.width - 2 * PAGE_MARGIN_MM, h: CAPTION_STRIP_MM },
      overlay: true,
    };
  }
  const strip = Math.min(CAPTION_STRIP_MM, r.h * 0.3);
  return {
    image: { x: r.x, y: r.y, w: r.w, h: Math.max(1, r.h - strip) },
    caption: { x: r.x, y: r.y + r.h - strip + CAPTION_GAP_MM, w: r.w, h: Math.max(1, strip - CAPTION_GAP_MM) },
    overlay: false,
  };
}

/** The dpi a photo of `px` pixels prints at when it covers a cell of `rect`. */
export function slotDpi(photoW: number | null, photoH: number | null, rect: RectMm): number | null {
  if (!photoW || !photoH) return null;
  const photoAspect = photoW / photoH;
  const cellAspect = rect.w / rect.h;
  // Covering the cell crops the longer side, so the shorter one decides.
  return photoAspect > cellAspect ? photoH / (rect.h / 25.4) : photoW / (rect.w / 25.4);
}

/** Spine width in mm: one sheet of paper holds two pages. */
export function spineWidthMm(pageCount: number, paperMm: number): number {
  const sheets = Math.ceil(Math.max(0, pageCount) / 2);
  return Math.round(sheets * paperMm * 10) / 10;
}

// ── selection ───────────────────────────────────────────────────────────

/** A face counts as recognisable from this share of the image area (5 % × 5 %). */
export const RECOGNISABLE_FACE_MIN_AREA = 0.0025;
/** … and when it is at least this sharp (`faces.sharpness`, 0..1), or not measured. */
export const RECOGNISABLE_FACE_MIN_SHARPNESS = 0.25;

export interface FaceBox {
  width: number;
  height: number;
  sharpness: number | null;
}

export function isRecognisableFace(f: FaceBox): boolean {
  if (!(f.width > 0) || !(f.height > 0)) return false;
  if (f.width * f.height < RECOGNISABLE_FACE_MIN_AREA) return false;
  return f.sharpness == null || f.sharpness >= RECOGNISABLE_FACE_MIN_SHARPNESS;
}

export interface BookPhoto {
  id: number;
  /** `photos.taken_at` as stored: local wall time, "YYYY-MM-DD HH:MM:SS". */
  takenAt: string | null;
  width: number | null;
  height: number | null;
  /** 0..100: aesthetics, else quality, else 50 (`photoScore`). */
  score: number;
  city: string | null;
  /** `photos.location_country`; only the chapter rule reads it. */
  country?: string | null;
}

/** `clip_aesthetics` and `ai_quality_score` are both 0..1. */
export function photoScore(aesthetic: number | null | undefined, quality: number | null | undefined): number {
  if (aesthetic != null && Number.isFinite(aesthetic)) return aesthetic * 100;
  if (quality != null && Number.isFinite(quality)) return quality * 100;
  return 50;
}

export function photoAspect(p: Pick<BookPhoto, "width" | "height">): number {
  return p.width && p.height ? p.width / p.height : 3 / 2;
}

function byTime(a: BookPhoto, b: BookPhoto): number {
  if (a.takenAt && b.takenAt) return a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : a.id - b.id;
  if (a.takenAt) return -1;
  if (b.takenAt) return 1;
  return a.id - b.id;
}

/** At most `max` photos: the best by score, back in chronological order. */
export function limitPhotos<T extends BookPhoto>(list: T[], max: number | null | undefined): T[] {
  const sorted = [...list].sort(byTime);
  if (!max || max <= 0 || sorted.length <= max) return sorted;
  const keep = new Set([...sorted].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, max).map((p) => p.id));
  return sorted.filter((p) => keep.has(p.id));
}

// ── chapters ────────────────────────────────────────────────────────────

/** A chapter with fewer photos joins the one before it. */
export const MIN_CHAPTER_PHOTOS = 4;
/** About this many photos make a chapter; the grain is picked to come closest. */
export const TARGET_CHAPTER_PHOTOS = 24;
/** More chapters than this make a book of openers. */
export const MAX_TARGET_CHAPTERS = 24;
/** A place grain needs a place on this share of the dated photos. */
export const PLACE_COVERAGE = 0.6;
/** Weeks only for a book that spans this many days: a long weekend cut at Monday is no chapter. */
export const WEEK_GRAIN_MIN_SPAN_DAYS = 14;

/** What a chapter is: one country, one town, or one fixed span of time. */
export type ChapterGrain = "country" | "city" | "day" | "week" | "month" | "year";
/** On a tie the earlier one wins: a place reads better than a date, a short span better than a long one. */
export const CHAPTER_GRAINS: ChapterGrain[] = ["city", "country", "day", "week", "month", "year"];

export interface ChapterDraft {
  title: string;
  subtitle: string | null;
  startsAt: string | null;
  endsAt: string | null;
  photos: BookPhoto[];
}

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

function datePart(takenAt: string): string {
  return takenAt.slice(0, 10);
}

function parseDay(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split("-").map((s) => parseInt(s, 10));
  return { y, m, d };
}

function dayNumber(day: string): number {
  const { y, m, d } = parseDay(day);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

function weekday(day: string): string {
  const { y, m, d } = parseDay(day);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** "3. Juni 2024" */
export function formatDay(day: string): string {
  const { y, m, d } = parseDay(day);
  return `${d}. ${MONTHS[m - 1]} ${y}`;
}

/** "1.–3. Juni 2024", "30. Mai – 2. Juni 2024", "30. Dezember 2023 – 2. Januar 2024" */
export function formatDayRange(from: string, to: string): string {
  if (from === to) return formatDay(from);
  const a = parseDay(from);
  const b = parseDay(to);
  if (a.y === b.y && a.m === b.m) return `${a.d}.–${b.d}. ${MONTHS[b.m - 1]} ${b.y}`;
  if (a.y === b.y) return `${a.d}. ${MONTHS[a.m - 1]} – ${b.d}. ${MONTHS[b.m - 1]} ${b.y}`;
  return `${formatDay(from)} – ${formatDay(to)}`;
}

/** "14:20" of a capture time, or null for a bare day or midnight (no time known). */
function clockTime(takenAt: string): string | null {
  const t = takenAt.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(t) && t !== "00:00" ? t : null;
}

/**
 * The span a chapter covers: "1.–3. Juni 2024" for more than one
 * day, else the day with the hours from the first to the last photo,
 * "Montag, 3. Juni 2024, 10:15–17:40 Uhr". `from` and `to` are capture
 * times or bare days; without a time of day only the day is said.
 */
export function chapterSubtitle(from: string, to: string): string {
  const a = datePart(from);
  const b = datePart(to);
  const days = dayNumber(b) - dayNumber(a) + 1;
  // The dates say how long it was; the number of days adds nothing.
  if (days > 1) return formatDayRange(a, b);
  const day = `${weekday(a)}, ${formatDay(a)}`;
  const start = clockTime(from);
  const end = clockTime(to);
  if (!start || !end) return day;
  return start === end ? `${day}, ${start} Uhr` : `${day}, ${start}–${end} Uhr`;
}

function mainCity(list: BookPhoto[]): string | null {
  const counts = new Map<string, number>();
  for (const p of list) if (p.city) counts.set(p.city, (counts.get(p.city) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [c, k] of counts) if (k > n) { best = c; n = k; }
  return best && n * 2 >= list.length ? best : null;
}

/** Monday of the week `day` lies in, as a day number (1970-01-01 was a Thursday). */
function weekStart(day: string): number {
  const n = dayNumber(day);
  return n - ((n + 3) % 7);
}

function dayOf(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

/** The key a photo has in a grain; null = no place known (it stays with its neighbours). */
function grainKey(grain: ChapterGrain, p: BookPhoto): string | null {
  const day = datePart(p.takenAt!);
  switch (grain) {
    case "day": return day;
    case "week": return String(weekStart(day));
    case "month": return day.slice(0, 7);
    case "year": return day.slice(0, 4);
    case "city": return p.city?.trim() ? `${p.city.trim()}|${p.country?.trim() ?? ""}` : null;
    case "country": return p.country?.trim() || null;
  }
}

export interface ChapterRun {
  key: string | null;
  photos: BookPhoto[];
}

/**
 * Consecutive photos with the same key. A photo without a place stays
 * in the run it was taken in; leading ones join the first place.
 */
function runsOf(grain: ChapterGrain, dated: BookPhoto[]): ChapterRun[] {
  const runs: ChapterRun[] = [];
  for (const p of dated) {
    const key = grainKey(grain, p);
    const last = runs[runs.length - 1];
    if (last && (key === null || last.key === key || last.key === null)) {
      if (last.key === null) last.key = key;
      last.photos.push(p);
    } else {
      runs.push({ key, photos: [p] });
    }
  }
  return runs;
}

/** Small runs join the one before them (the first one the next). */
function mergeSmall(runs: ChapterRun[]): { groups: ChapterRun[][]; absorbed: number } {
  const groups: ChapterRun[][] = [];
  let absorbed = 0;
  for (const r of runs) {
    if (groups.length && r.photos.length < MIN_CHAPTER_PHOTOS) {
      groups[groups.length - 1].push(r);
      absorbed += r.photos.length;
    } else {
      groups.push([r]);
    }
  }
  if (groups.length > 1 && groups[0].length === 1 && groups[0][0].photos.length < MIN_CHAPTER_PHOTOS) {
    absorbed += groups[0][0].photos.length;
    groups[1].unshift(...groups[0]);
    groups.shift();
  }
  return { groups, absorbed };
}

/** How many chapters the book should have for `n` photos. */
export function targetChapters(n: number): number {
  return Math.min(MAX_TARGET_CHAPTERS, Math.max(1, n / TARGET_CHAPTER_PHOTOS));
}

export interface GrainChoice {
  grain: ChapterGrain;
  groups: ChapterRun[][];
}

/**
 * The grain whose chapters come closest to `targetChapters`: the
 * distance is counted on a log scale (twice as many is as far off as
 * half as many), plus the share of photos that ended up in a chapter
 * not their own. A place grain needs `PLACE_COVERAGE` and two places,
 * the week a span of `WEEK_GRAIN_MIN_SPAN_DAYS`.
 */
export function chooseChapterGrain(dated: BookPhoto[]): GrainChoice {
  const target = targetChapters(dated.length);
  const span = dayNumber(datePart(dated[dated.length - 1].takenAt!)) - dayNumber(datePart(dated[0].takenAt!)) + 1;
  let best: (GrainChoice & { cost: number }) | null = null;
  for (const grain of CHAPTER_GRAINS) {
    if (grain === "city" || grain === "country") {
      const known = dated.filter((p) => grainKey(grain, p) !== null);
      if (known.length < dated.length * PLACE_COVERAGE) continue;
      if (new Set(known.map((p) => grainKey(grain, p))).size < 2) continue;
    }
    if (grain === "week" && span < WEEK_GRAIN_MIN_SPAN_DAYS) continue;
    const { groups, absorbed } = mergeSmall(runsOf(grain, dated));
    const cost = Math.abs(Math.log(groups.length / target)) + absorbed / dated.length;
    if (!best || cost < best.cost - 1e-9) best = { grain, groups, cost };
  }
  return { grain: best!.grain, groups: best!.groups };
}

function monthSpan(from: string, to: string): string {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y) return `${MONTHS[a.m - 1]} – ${MONTHS[b.m - 1]} ${b.y}`;
  return `${MONTHS[a.m - 1]} ${a.y} – ${MONTHS[b.m - 1]} ${b.y}`;
}

/** The place that holds most of the chapter's photos. */
function mainKey(runs: ChapterRun[]): string | null {
  const counts = new Map<string, number>();
  for (const r of runs) if (r.key) counts.set(r.key, (counts.get(r.key) ?? 0) + r.photos.length);
  let best: string | null = null;
  let n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
}

/**
 * Title and subtitle of a chapter: the title names its period and
 * nothing else ("Musterstadt", "Juni 2024", "Woche ab 3. Juni 2024",
 * "Montag, 3. Juni 2024"); the subtitle adds what the title leaves out
 * — the days, the hours of a single day, the town of a span of time.
 */
function chapterTexts(grain: ChapterGrain, runs: ChapterRun[]): { title: string; subtitle: string | null } {
  const photos = runs.flatMap((r) => r.photos);
  const first = photos[0].takenAt!;
  const last = photos[photos.length - 1].takenAt!;
  const from = datePart(first);
  const to = datePart(last);
  const dates = chapterSubtitle(first, last);
  const city = mainCity(photos);
  const withCity = (s: string | null) => (city ? (s ? `${s} · ${city}` : city) : s);

  switch (grain) {
    case "city":
    case "country": {
      const key = mainKey(runs);
      const title = key ? (grain === "city" ? key.split("|")[0] : key) : formatDayRange(from, to);
      return { title, subtitle: dates };
    }
    case "day": {
      if (from !== to) return { title: formatDayRange(from, to), subtitle: withCity(null) };
      const start = clockTime(first);
      const end = clockTime(last);
      const hours = start && end ? (start === end ? `${start} Uhr` : `${start}–${end} Uhr`) : null;
      return { title: `${weekday(from)}, ${formatDay(from)}`, subtitle: withCity(hours) };
    }
    case "week": {
      const a = weekStart(from);
      const b = weekStart(to);
      const title = a === b ? `Woche ab ${formatDay(dayOf(a))}` : formatDayRange(dayOf(a), dayOf(b + 6));
      return { title, subtitle: withCity(dates) };
    }
    case "month":
      return { title: monthSpan(from, to), subtitle: withCity(dates) };
    case "year": {
      const a = from.slice(0, 4);
      const b = to.slice(0, 4);
      return { title: a === b ? a : `${a}–${b}`, subtitle: withCity(dates) };
    }
  }
}

/**
 * Chapters of fixed periods: one per country, town, day, week, month
 * or year, whichever fits the number of photos best
 * (`chooseChapterGrain`); a chapter below `MIN_CHAPTER_PHOTOS` joins
 * the one before it; undated photos come last.
 */
export function buildChapters(list: BookPhoto[]): ChapterDraft[] {
  const sorted = [...list].sort(byTime);
  const dated = sorted.filter((p) => p.takenAt);
  const undated = sorted.filter((p) => !p.takenAt);
  const out: ChapterDraft[] = [];

  if (dated.length) {
    const { grain, groups } = chooseChapterGrain(dated);
    for (const runs of groups) {
      const photos = runs.flatMap((r) => r.photos);
      const { title, subtitle } = chapterTexts(grain, runs);
      out.push({ title, subtitle, startsAt: photos[0].takenAt, endsAt: photos[photos.length - 1].takenAt, photos });
    }
  }

  if (undated.length) {
    out.push({ title: "Ohne Datum", subtitle: null, startsAt: null, endsAt: null, photos: undated });
  }
  return out;
}

// ── pages ───────────────────────────────────────────────────────────────

export interface PageDraft {
  kind: PageKind;
  layout: string;
  /** In cell order. */
  photoIds: number[];
}

/** How much of a photo a cell cuts away when it covers it (0 = nothing). */
export function cropLoss(photoAspect: number, cellAspect: number): number {
  return 1 - Math.min(photoAspect / cellAspect, cellAspect / photoAspect);
}

function cellAspect(format: PhotoBookFormat, layout: BookLayout, c: BookCell): number {
  const r = cellRect(format, layout, c);
  return r.w / r.h;
}

function permutations<T>(list: T[]): T[][] {
  if (list.length <= 1) return [list];
  const out: T[][] = [];
  list.forEach((item, i) => {
    for (const rest of permutations([...list.slice(0, i), ...list.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

function largestCell(cells: BookCell[]): number {
  let best = 0;
  cells.forEach((c, i) => { if (c.w * c.h > cells[best].w * cells[best].h + 1e-9) best = i; });
  return best;
}

export interface LayoutChoice {
  layout: BookLayout;
  /** The photos in cell order. */
  photos: BookPhoto[];
  cost: number;
}

/**
 * Every layout for `photos` on one page, each with the cell order that crops
 * the least, cheapest first. The best photo should sit in the largest cell
 * when cells differ in size; `avoid` (the previous page's layout) costs a
 * little extra. Stage 3 hands the first few to the model.
 */
export function rankLayouts(format: PhotoBookFormat, photos: BookPhoto[], avoid?: string | null): LayoutChoice[] {
  const out: LayoutChoice[] = [];
  if (!photos.length) return out;
  const bestPhoto = [...photos].sort((a, b) => b.score - a.score || a.id - b.id)[0];
  for (const layout of bookLayouts("photos", photos.length)) {
    const big = largestCell(layout.cells);
    const sizesDiffer = layout.cells.some((c) => Math.abs(c.w * c.h - layout.cells[big].w * layout.cells[big].h) > 1e-6);
    let best: LayoutChoice | null = null;
    for (const order of permutations(photos)) {
      let loss = 0;
      order.forEach((p, i) => { loss += cropLoss(photoAspect(p), cellAspect(format, layout, layout.cells[i])); });
      let cost = loss / order.length;
      if (sizesDiffer && order[big].id !== bestPhoto.id) cost += 0.08;
      if (avoid && layout.id === avoid) cost += 0.05;
      // Keep the chronological order unless another one crops clearly less.
      order.forEach((p, i) => { if (p.id !== photos[i].id) cost += 0.005; });
      if (!best || cost < best.cost - 1e-9) best = { layout, photos: order, cost };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/** The cheapest of `rankLayouts`. */
export function chooseLayout(format: PhotoBookFormat, photos: BookPhoto[], avoid?: string | null): LayoutChoice | null {
  return rankLayouts(format, photos, avoid)[0] ?? null;
}

/** The share of a chapter's photos that may get a page of their own. */
const HERO_SHARE = 0.12;
/** A single photo goes full bleed when it crops at most this much. */
const FULL_BLEED_MAX_LOSS = 0.15;
/** Group sizes cost this much on top of their crop, so pages vary but favour three. */
const GROUP_BIAS: Record<number, number> = { 2: 0.04, 3: 0, 4: 0.03 };

function singlePage(format: PhotoBookFormat, p: BookPhoto): PageDraft {
  const f = PHOTO_BOOK_FORMATS[format];
  const loss = cropLoss(photoAspect(p), f.width / f.height);
  return { kind: "photos", layout: loss <= FULL_BLEED_MAX_LOSS ? "full" : "single", photoIds: [p.id] };
}

/** The rule-based pages of one chapter: an opener, then pages of one to four photos. */
export function buildChapterPages(format: PhotoBookFormat, list: BookPhoto[]): PageDraft[] {
  if (!list.length) return [];
  const pages: PageDraft[] = [];
  const hero = [...list].sort((a, b) => b.score - a.score || a.id - b.id)[0];
  pages.push({ kind: "opener", layout: OPENER_LAYOUT.id, photoIds: [hero.id] });

  const rest = list.filter((p) => p.id !== hero.id);
  const heroCount = Math.floor(rest.length * HERO_SHARE);
  const heroes = new Set([...rest].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, heroCount).map((p) => p.id));

  let previous: string | null = null;
  let i = 0;
  while (i < rest.length) {
    const p = rest[i];
    if (heroes.has(p.id) || rest.length - i === 1) {
      const page = singlePage(format, p);
      pages.push(page);
      previous = page.layout;
      i += 1;
      continue;
    }
    let best: { choice: LayoutChoice; n: number; score: number } | null = null;
    for (let n = 2; n <= MAX_PHOTOS_PER_PAGE && i + n <= rest.length; n++) {
      const group = rest.slice(i, i + n);
      // A hero inside the group ends it: the hero gets its own page next.
      if (group.slice(1).some((g) => heroes.has(g.id))) break;
      const choice = chooseLayout(format, group, previous);
      if (!choice) continue;
      let score = choice.cost + (GROUP_BIAS[n] ?? 0);
      // Leaving a single photo at the end of a chapter would cost a page.
      if (rest.length - (i + n) === 1 && n < MAX_PHOTOS_PER_PAGE) score += 0.03;
      if (!best || score < best.score - 1e-9) best = { choice, n, score };
    }
    if (!best) {
      const page = singlePage(format, p);
      pages.push(page);
      previous = page.layout;
      i += 1;
      continue;
    }
    pages.push({ kind: "photos", layout: best.choice.layout.id, photoIds: best.choice.photos.map((x) => x.id) });
    previous = best.choice.layout.id;
    i += best.n;
  }
  return pages;
}

/**
 * The layout a page takes after its photo count changed: the best fit for
 * the new count; null for a photo page left empty (it goes), the title alone
 * for an opener.
 */
export function relayoutPage(format: PhotoBookFormat, kind: PageKind, photos: BookPhoto[]): PageDraft | null {
  if (kind === "opener") {
    return photos.length
      ? { kind, layout: OPENER_LAYOUT.id, photoIds: [photos[0].id] }
      : { kind, layout: OPENER_TEXT_LAYOUT.id, photoIds: [] };
  }
  if (!photos.length) return null;
  if (photos.length === 1) return singlePage(format, photos[0]);
  const choice = chooseLayout(format, photos);
  return choice ? { kind, layout: choice.layout.id, photoIds: choice.photos.map((p) => p.id) } : null;
}

// ── edited photos ───────────────────────────────────────────────────────

/** A photo on a page, as edited and as it was before. */
export interface EditedBookPhoto extends BookPhoto {
  /** The original's size; differs from `width`/`height` when an edit crops or turns it. */
  originalWidth: number | null;
  originalHeight: number | null;
}

/** An edit changes a photo's shape when its aspect moves by more than this (log ratio, ≈ 5 %). */
const SHAPE_CHANGE = 0.05;
/** A page is worth laying out again when that cuts this much less of its photos on average. */
export const EDIT_MISFIT_MARGIN = 0.05;

/** Whether an edit gave the photo another shape (turned it, or cropped it to another aspect). */
export function shapeChanged(p: EditedBookPhoto): boolean {
  if (!p.width || !p.height || !p.originalWidth || !p.originalHeight) return false;
  return Math.abs(Math.log((p.width / p.height) / (p.originalWidth / p.originalHeight))) > SHAPE_CHANGE;
}

/** How much a layout cuts away of its photos (in cell order), on average. */
export function pageCropLoss(format: PhotoBookFormat, layout: BookLayout, photos: Pick<BookPhoto, "width" | "height">[]): number {
  if (!photos.length) return 0;
  let loss = 0;
  photos.forEach((p, i) => {
    const c = layout.cells[i];
    if (c) loss += cropLoss(photoAspect(p), cellAspect(format, layout, c));
  });
  return loss / photos.length;
}

/**
 * Whether a page no longer fits photos that were edited after it was laid out,
 * and what to do about it. A page qualifies when one of its photos changed its
 * shape and the rule's layout for the photos as they are now cuts clearly
 * less: "relayout" when the rule (or the model) chose the layout, so "Seiten
 * anpassen" lays it out again; "own_layout" when the user chose it, which
 * stays — the page only says so. Openers have one layout and never qualify.
 */
export function editMisfit(
  format: PhotoBookFormat,
  kind: PageKind,
  layout: BookLayout,
  layoutSource: "rule" | "llm" | "user",
  photos: EditedBookPhoto[],
): "relayout" | "own_layout" | null {
  if (kind !== "photos" || !photos.some(shapeChanged)) return null;
  const draft = relayoutPage(format, kind, photos);
  if (!draft) return null;
  const next = findBookLayout(kind, draft.photoIds.length, draft.layout);
  if (!next) return null;
  const byId = new Map(photos.map((p) => [p.id, p]));
  const nextLoss = pageCropLoss(format, next, draft.photoIds.map((id) => byId.get(id)!));
  if (nextLoss >= pageCropLoss(format, layout, photos) - EDIT_MISFIT_MARGIN) return null;
  return layoutSource === "user" ? "own_layout" : "relayout";
}

// ── captions on a page ──────────────────────────────────────────────────

/** A caption as compared with the others of its page: case, spaces and punctuation aside. */
export function captionKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Which captions of a page repeat one before them. A page says a thing once:
 * the first photo with a caption keeps it, the same text under its
 * neighbours is left out (in the editor, the preview and the PDF).
 */
export function repeatedCaptions(captions: (string | null | undefined)[]): boolean[] {
  const seen = new Set<string>();
  return captions.map((c) => {
    if (!c) return false;
    const key = captionKey(c);
    if (!key) return false;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
}

// ── print resolution ────────────────────────────────────────────────────

/** How many photos of a page print under `MIN_PRINT_DPI` in `layout`, photos in cell order. */
export function lowDpiSlots(
  format: PhotoBookFormat,
  layout: BookLayout,
  photos: Pick<BookPhoto, "width" | "height">[],
  captioned: boolean,
): number {
  let low = 0;
  photos.forEach((p, i) => {
    const c = layout.cells[i];
    if (!c) return;
    const dpi = slotDpi(p.width, p.height, slotGeometry(format, layout, c, captioned).image);
    if (dpi != null && dpi < MIN_PRINT_DPI) low += 1;
  });
  return low;
}

export interface SharpArrangement<T extends BookPhoto> {
  layout: BookLayout;
  /** The photos in cell order. */
  photos: T[];
  /** Photos still under `MIN_PRINT_DPI`. */
  low: number;
}

/**
 * The arrangement of a page's photos that leaves the fewest of them under
 * `MIN_PRINT_DPI`: every layout for the same number of photos, every cell
 * order (a small photo goes to a smaller cell). Among those as sharp, the one
 * that crops least, keeping the current layout and order when they are as good.
 */
export function sharpestArrangement<T extends BookPhoto>(
  format: PhotoBookFormat,
  kind: PageKind,
  current: BookLayout,
  photos: T[],
  captioned: boolean,
): SharpArrangement<T> {
  let best: (SharpArrangement<T> & { cost: number }) | null = null;
  for (const layout of bookLayouts(kind, photos.length)) {
    for (const order of permutations(photos)) {
      const low = lowDpiSlots(format, layout, order, captioned);
      let cost = pageCropLoss(format, layout, order);
      if (layout.id !== current.id) cost += 0.02;
      order.forEach((p, i) => { if (p.id !== photos[i].id) cost += 0.005; });
      if (!best || low < best.low || (low === best.low && cost < best.cost - 1e-9)) best = { layout, photos: order, low, cost };
    }
  }
  return best ? { layout: best.layout, photos: best.photos, low: best.low } : { layout: current, photos, low: lowDpiSlots(format, current, photos, captioned) };
}

/**
 * The layout a photo gets on a page of its own when it is to print sharp
 * there: the rule's choice when that is sharp enough, else the other one
 * (full bleed is the larger); null when it prints under `MIN_PRINT_DPI` even
 * alone — then only a larger photo helps.
 */
export function sharpSinglePage(format: PhotoBookFormat, p: BookPhoto, captioned: boolean): string | null {
  const preferred = singlePage(format, p).layout;
  const layouts = [...bookLayouts("photos", 1)].sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0));
  return layouts.find((l) => lowDpiSlots(format, l, [p], captioned) === 0)?.id ?? null;
}
