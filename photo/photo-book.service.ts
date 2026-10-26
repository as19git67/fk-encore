/**
 * Photo books (documentation/plans/fotobuch.md, issue #1729): building a book
 * from a selection or an album, loading it for the editor, and the edits the
 * editor makes. A book belongs to its owner alone; every photo in it passes
 * `accessiblePhotoCondition` of that owner when it enters and again when the
 * book is loaded, so a photo the owner can no longer see silently drops out.
 *
 * The rules (formats, layouts, chapters, page builder) are in
 * `photo-book-layout.ts`; the PDF in `photo-book-pdf.ts`.
 */

import { APIError } from "encore.dev/api";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import {
  albumPhotos,
  albumShares,
  albums,
  collectionMembers,
  photoBook,
  photoBookCaption,
  photoBookChapter,
  photoBookPage,
  photoBookSlot,
  photoCuration,
  photos,
  type PhotoBookSettings,
  type PhotoBookSource,
  type PhotoBookTextSource,
  type PhotoBookWeights,
} from "../db/schema";
import { loadReadableCollection } from "../documents/collection-access";
import { accessiblePhotoCondition, accessiblePhotoConditionFor } from "./photo-file-access";
import { aestheticScoreSql } from "./photo.filters";
import {
  MIN_PRINT_DPI,
  PHOTO_BOOK_FORMATS,
  RECOGNISABLE_FACE_MIN_AREA,
  RECOGNISABLE_FACE_MIN_SHARPNESS,
  bookLayouts,
  buildChapterPages,
  buildChapters,
  findBookLayout,
  isPhotoBookFormat,
  limitPhotos,
  photoScore,
  relayoutPage,
  slotDpi,
  slotGeometry,
  spineWidthMm,
  textRect,
  type BookLayout,
  type BookPhoto,
  type PageKind,
  type PhotoBookFormat,
  type RectMm,
} from "./photo-book-layout";
import {
  cleanWeights,
  dropSimilarPhotos,
  hasWeights,
  keepSeriesPicks,
  loadSeries,
  loadSubjectShares,
  weightedScore,
} from "./photo-book-subjects";

/** A book holds at most this many photos; the narrowing keeps the best. */
export const MAX_BOOK_PHOTOS = 600;

export const DEFAULT_BOOK_SETTINGS: Required<PhotoBookSettings> = {
  bleed_mm: 3,
  crop_marks: false,
  spreads: true,
  paper_mm: 0.12,
  captions: false,
};

export function bookSettings(s: PhotoBookSettings | null | undefined): Required<PhotoBookSettings> {
  const out = { ...DEFAULT_BOOK_SETTINGS };
  if (s?.bleed_mm != null && Number.isFinite(s.bleed_mm)) out.bleed_mm = Math.min(10, Math.max(0, s.bleed_mm));
  if (s?.crop_marks != null) out.crop_marks = !!s.crop_marks;
  if (s?.spreads != null) out.spreads = !!s.spreads;
  if (s?.paper_mm != null && Number.isFinite(s.paper_mm)) out.paper_mm = Math.min(1, Math.max(0.03, s.paper_mm));
  if (s?.captions != null) out.captions = !!s.captions;
  return out;
}

// ── types the endpoints return ──────────────────────────────────────────

/** A rectangle as a share of the trim box (0..1), for the editor's preview. */
export interface PageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhotoBookSlotView {
  slot: number;
  photo_id: number;
  filename: string;
  auto_crop: { x: number; y: number } | null;
  /** Where the photo goes (without its caption strip). */
  rect: PageRect;
  /** The dpi it prints at; null while the photo's size is unknown. */
  dpi: number | null;
  low_dpi: boolean;
  caption: string | null;
  caption_source: "llm" | "user" | null;
  /** Where the caption goes on this page; null when the page shows none. */
  caption_rect: PageRect | null;
  caption_overlay: boolean;
}

export interface PhotoBookLayoutOption {
  id: string;
  name: string;
}

export interface PhotoBookPageView {
  id: number;
  position: number;
  chapter_id: number | null;
  kind: PageKind;
  layout: string;
  layout_options: PhotoBookLayoutOption[];
  full_bleed: boolean;
  text_rect: PageRect | null;
  /** Whether the page shows captions, after the book's setting. */
  captions: boolean;
  /** The page's own setting; null follows the book. */
  captions_override: boolean | null;
  layout_source: PhotoBookTextSource;
  /** Why the model picked this layout (stage 3). */
  layout_reason: string | null;
  slots: PhotoBookSlotView[];
}

export interface PhotoBookChapterView {
  id: number;
  position: number;
  title: string;
  subtitle: string | null;
  starts_at: string | null;
  ends_at: string | null;
  title_source: PhotoBookTextSource;
  /** The model's proposal, also when the user's own title stays. */
  title_suggestion: string | null;
}

export interface PhotoBookFormatOption {
  id: PhotoBookFormat;
  name: string;
  width_mm: number;
  height_mm: number;
}

export interface PhotoBookSettingsView {
  bleed_mm: number;
  crop_marks: boolean;
  spreads: boolean;
  paper_mm: number;
  captions: boolean;
}

export interface PhotoBookView {
  id: number;
  title: string;
  subtitle: string | null;
  format: PhotoBookFormat;
  width_mm: number;
  height_mm: number;
  cover_photo_id: number | null;
  cover_filename: string | null;
  cover_auto_crop: { x: number; y: number } | null;
  settings: PhotoBookSettingsView;
  source: PhotoBookSource;
  page_count: number;
  photo_count: number;
  spine_mm: number;
  low_dpi_count: number;
  chapters: PhotoBookChapterView[];
  pages: PhotoBookPageView[];
  created_at: string;
  updated_at: string;
}

export interface PhotoBookSummary {
  id: number;
  title: string;
  subtitle: string | null;
  format: PhotoBookFormat;
  page_count: number;
  photo_count: number;
  cover_filename: string | null;
  updated_at: string;
}

export function photoBookFormats(): PhotoBookFormatOption[] {
  return Object.values(PHOTO_BOOK_FORMATS).map((f) => ({ id: f.id, name: f.name, width_mm: f.width, height_mm: f.height }));
}

// ── selection ───────────────────────────────────────────────────────────

export interface PhotoBookNarrowing {
  /** 0..100 */
  qualityMin?: number | null;
  /** 0..100 */
  aestheticMin?: number | null;
  withoutRecognisableFaces?: boolean;
  maxPhotos?: number | null;
  /** -1 (fewer) .. 1 (more) per subject (stage 4). */
  weights?: PhotoBookWeights | null;
  /** A series of near-duplicates contributes only its pick (stage 4); on by default. */
  groupPicksOnly?: boolean;
}

interface PhotoRow {
  id: number;
  taken_at: string | null;
  width: number | null;
  height: number | null;
  quality: number | null;
  aesthetic: number | null;
  city: string | null;
}

/** A face on the photo that could identify someone (`isRecognisableFace` in SQL). */
export const recognisableFaceSql: SQL = sql`EXISTS (
  SELECT 1 FROM faces f
  WHERE f.photo_id = ${photos.id}
    AND COALESCE((f.bbox::jsonb->>'width')::float8, 0) * COALESCE((f.bbox::jsonb->>'height')::float8, 0) >= ${RECOGNISABLE_FACE_MIN_AREA}
    AND (f.sharpness IS NULL OR f.sharpness >= ${RECOGNISABLE_FACE_MIN_SHARPNESS})
)`;

function percent(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return Math.min(100, v);
}

async function assertAlbumVisible(userId: number, albumId: number): Promise<void> {
  const album = await dbFirst<{ user_id: number }>(db.select({ user_id: albums.user_id }).from(albums).where(eq(albums.id, albumId)));
  if (!album) throw APIError.notFound("album not found");
  if (album.user_id === userId) return;
  const share = await dbFirst(db.select({ a: albumShares.album_id }).from(albumShares)
    .where(and(eq(albumShares.album_id, albumId), eq(albumShares.user_id, userId))));
  if (!share) throw APIError.notFound("album not found");
}

/**
 * The photos of a collection or the basket (stage 5): its photos and the
 * photos of its albums the owner may see. The owner must be able to read the
 * collection; every photo still passes the access check of the selection.
 */
async function collectionPhotoIds(userId: number, collectionId: number): Promise<number[]> {
  await loadReadableCollection(userId, collectionId, false);
  return collectionMemberPhotoIds(userId, collectionId);
}

async function collectionMemberPhotoIds(userId: number, collectionId: number): Promise<number[]> {
  const rows = await dbAll<{ entity_type: string; entity_id: number }>(
    db.select({ entity_type: collectionMembers.entity_type, entity_id: collectionMembers.entity_id })
      .from(collectionMembers)
      .where(and(eq(collectionMembers.collection_id, collectionId), inArray(collectionMembers.entity_type, ["photo", "album"]))),
  );
  const ids = new Set(rows.filter((r) => r.entity_type === "photo").map((r) => Number(r.entity_id)));
  const albumIds = rows.filter((r) => r.entity_type === "album").map((r) => Number(r.entity_id));
  if (albumIds.length) {
    const visible = await dbAll<{ id: number }>(
      db.select({ id: albums.id }).from(albums).where(and(
        inArray(albums.id, albumIds),
        sql`(${albums.user_id} = ${userId} OR EXISTS (SELECT 1 FROM ${albumShares} s WHERE s.album_id = ${albums.id} AND s.user_id = ${userId}))`,
      )),
    );
    if (visible.length) {
      const inAlbums = await dbAll<{ photo_id: number }>(
        db.select({ photo_id: albumPhotos.photo_id }).from(albumPhotos).where(inArray(albumPhotos.album_id, visible.map((a) => a.id))),
      );
      for (const r of inAlbums) ids.add(r.photo_id);
    }
  }
  return [...ids];
}

/**
 * The photos a book built from `source` holds for `userId`: visible to them,
 * pictures (no videos), not hidden by them, through the narrowing, in
 * chronological order. Subject weights move the scores the narrowing keeps
 * the best by; a series of near-duplicates gives only its pick.
 */
export async function selectBookPhotos(userId: number, source: PhotoBookSource): Promise<BookPhoto[]> {
  const conds: SQL[] = [
    accessiblePhotoCondition(userId),
    sql`${photos.mime_type} LIKE 'image/%'`,
    sql`NOT EXISTS (SELECT 1 FROM ${photoCuration} pc WHERE pc.photo_id = ${photos.id} AND pc.user_id = ${userId} AND pc.status = 'hidden')`,
  ];
  if (source.kind === "album") {
    if (!source.album_id) throw APIError.invalidArgument("album_id is required");
    await assertAlbumVisible(userId, source.album_id);
    conds.push(sql`EXISTS (SELECT 1 FROM ${albumPhotos} ap WHERE ap.photo_id = ${photos.id} AND ap.album_id = ${source.album_id})`);
  } else if (source.kind === "collection") {
    if (!source.collection_id) throw APIError.invalidArgument("collection_id is required");
    const ids = await collectionPhotoIds(userId, source.collection_id);
    if (!ids.length) return [];
    conds.push(inArray(photos.id, ids));
  } else {
    const ids = [...new Set(source.photo_ids ?? [])].filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return [];
    conds.push(inArray(photos.id, ids));
  }
  const q = percent(source.quality_min);
  if (q != null) conds.push(sql`${photos.ai_quality_score} >= ${q / 100}`);
  const a = percent(source.aesthetic_min);
  if (a != null) conds.push(sql`${aestheticScoreSql} >= ${a / 100}`);
  if (source.without_recognisable_faces) conds.push(sql`NOT ${recognisableFaceSql}`);

  const rows = await dbAll<PhotoRow>(
    db.select({
      id: photos.id,
      taken_at: photos.taken_at,
      width: photos.width,
      height: photos.height,
      quality: photos.ai_quality_score,
      aesthetic: aestheticScoreSql,
      city: photos.location_city,
    }).from(photos).where(and(...conds)),
  );
  let list: BookPhoto[] = rows.map((r) => ({
    id: r.id,
    takenAt: r.taken_at,
    width: r.width,
    height: r.height,
    score: photoScore(r.aesthetic, r.quality),
    city: r.city,
  }));
  if (hasWeights(source.weights) && list.length) {
    const shares = await loadSubjectShares(list.map((p) => p.id));
    list = list.map((p) => ({ ...p, score: weightedScore(p.score, shares.get(p.id), source.weights) }));
  }
  if (source.group_picks_only === true && list.length > 1) {
    list = keepSeriesPicks(list, await loadSeries(userId, list.map((p) => p.id)));
    list = await dropSimilarPhotos(list);
  }
  const max = source.max_photos && source.max_photos > 0 ? Math.min(source.max_photos, MAX_BOOK_PHOTOS) : MAX_BOOK_PHOTOS;
  return limitPhotos(list, max);
}

// ── building ────────────────────────────────────────────────────────────

/** Replace chapters and pages of `bookId` with the rule-based ones for `list`. */
async function writeBookContent(bookId: number, format: PhotoBookFormat, list: BookPhoto[]): Promise<void> {
  await dbExec(db.delete(photoBookPage).where(eq(photoBookPage.book_id, bookId)));
  await dbExec(db.delete(photoBookChapter).where(eq(photoBookChapter.book_id, bookId)));
  let position = 0;
  const chapters = buildChapters(list);
  for (let c = 0; c < chapters.length; c++) {
    const ch = chapters[c];
    const row = await dbInsertReturning<{ id: number }>(
      db.insert(photoBookChapter).values({
        book_id: bookId,
        position: c,
        title: ch.title,
        subtitle: ch.subtitle,
        starts_at: ch.startsAt,
        ends_at: ch.endsAt,
      }).returning({ id: photoBookChapter.id }),
    );
    for (const page of buildChapterPages(format, ch.photos)) {
      const p = await dbInsertReturning<{ id: number }>(
        db.insert(photoBookPage).values({
          book_id: bookId,
          chapter_id: row!.id,
          position: position++,
          kind: page.kind,
          layout: page.layout,
          rule_layout: page.layout,
        })
          .returning({ id: photoBookPage.id }),
      );
      if (page.photoIds.length) {
        await dbExec(db.insert(photoBookSlot).values(page.photoIds.map((photo_id, slot) => ({ page_id: p!.id, slot, photo_id }))));
      }
    }
  }
}

function bestCover(list: BookPhoto[]): number | null {
  const best = [...list].sort((a, b) => b.score - a.score || a.id - b.id)[0];
  return best?.id ?? null;
}

/** The narrowing as the source stores it. */
function narrowingSource(input: PhotoBookNarrowing): Omit<PhotoBookSource, "kind"> {
  return {
    quality_min: percent(input.qualityMin),
    aesthetic_min: percent(input.aestheticMin),
    without_recognisable_faces: !!input.withoutRecognisableFaces,
    max_photos: input.maxPhotos && input.maxPhotos > 0 ? Math.min(input.maxPhotos, MAX_BOOK_PHOTOS) : null,
    weights: cleanWeights(input.weights),
    group_picks_only: input.groupPicksOnly !== false,
  };
}

export interface CreatePhotoBookInput extends PhotoBookNarrowing {
  title: string;
  subtitle?: string | null;
  format?: PhotoBookFormat;
  /** A selection; or `albumId`, or `collectionId` (a collection or the basket). */
  photoIds?: number[];
  albumId?: number;
  collectionId?: number;
}

export async function createPhotoBook(userId: number, input: CreatePhotoBookInput): Promise<number> {
  const title = input.title?.trim();
  if (!title) throw APIError.invalidArgument("title is required");
  const format = input.format ?? "a4-landscape";
  if (!isPhotoBookFormat(format)) throw APIError.invalidArgument(`unknown format ${String(format)}`);
  if (!input.albumId && !input.collectionId && !input.photoIds?.length) {
    throw APIError.invalidArgument("photoIds, albumId or collectionId is required");
  }

  // The basket changes all the time: a book made from it keeps the photos it
  // held then, so "Neu verteilen" does not pull in what was added since.
  let collectionId = input.collectionId;
  let photoIds = input.photoIds;
  if (collectionId && !input.albumId) {
    const col = await loadReadableCollection(userId, collectionId, false);
    if (col.kind === "basket") {
      photoIds = await collectionMemberPhotoIds(userId, collectionId);
      collectionId = undefined;
      if (!photoIds.length) throw APIError.failedPrecondition("no photos left after narrowing");
    }
  }
  const source: PhotoBookSource = {
    kind: input.albumId ? "album" : collectionId ? "collection" : "photos",
    ...(input.albumId
      ? { album_id: input.albumId }
      : collectionId
        ? { collection_id: collectionId }
        : { photo_ids: [...new Set(photoIds)] }),
    ...narrowingSource(input),
  };
  const list = await selectBookPhotos(userId, source);
  if (!list.length) throw APIError.failedPrecondition("no photos left after narrowing");

  const row = await dbInsertReturning<{ id: number }>(
    db.insert(photoBook).values({
      user_id: userId,
      title,
      subtitle: input.subtitle?.trim() || null,
      format,
      cover_photo_id: bestCover(list),
      source,
    }).returning({ id: photoBook.id }),
  );
  await writeBookContent(row!.id, format, list);
  return row!.id;
}

async function ownedBook(userId: number, bookId: number) {
  const book = await dbFirst<typeof photoBook.$inferSelect>(
    db.select().from(photoBook).where(and(eq(photoBook.id, bookId), eq(photoBook.user_id, userId))),
  );
  if (!book) throw APIError.notFound("photo book not found");
  return book;
}

async function touch(bookId: number): Promise<void> {
  await dbExec(db.update(photoBook).set({ updated_at: sql`now()` }).where(eq(photoBook.id, bookId)));
}

/** Build the book again from its source and narrowing; titles, format and settings stay. */
/**
 * Lays the book out again from its source. With `narrowing` the book's
 * narrowing is replaced first (the source itself — photos, album or
 * collection — stays), so quality, aesthetics, faces, the maximum and the
 * weights can be changed after the book was made. Nothing is stored when
 * the new narrowing leaves no photo.
 */
export async function rebuildPhotoBook(userId: number, bookId: number, narrowing?: PhotoBookNarrowing): Promise<void> {
  const book = await ownedBook(userId, bookId);
  const source: PhotoBookSource = narrowing ? { ...book.source, ...narrowingSource(narrowing) } : book.source;
  const list = await selectBookPhotos(userId, source);
  if (!list.length) throw APIError.failedPrecondition("no photos left after narrowing");
  const format = isPhotoBookFormat(book.format) ? book.format : "a4-landscape";
  await writeBookContent(bookId, format, list);
  const keepCover = book.cover_photo_id != null && list.some((p) => p.id === book.cover_photo_id);
  await dbExec(db.update(photoBook).set({
    cover_photo_id: keepCover ? book.cover_photo_id : bestCover(list),
    ...(narrowing ? { source } : {}),
    updated_at: sql`now()`,
  })
    .where(eq(photoBook.id, bookId)));
}

// ── loading ─────────────────────────────────────────────────────────────

interface SlotPhotoRow {
  page_id: number;
  slot: number;
  photo_id: number;
  filename: string;
  width: number | null;
  height: number | null;
  auto_crop: { x: number; y: number } | null;
  taken_at: string | null;
  quality: number | null;
  aesthetic: number | null;
  city: string | null;
}

function toBookPhoto(r: SlotPhotoRow): BookPhoto {
  return { id: r.photo_id, takenAt: r.taken_at, width: r.width, height: r.height, score: photoScore(r.aesthetic, r.quality), city: r.city };
}

function share(rect: RectMm, format: PhotoBookFormat): PageRect {
  const f = PHOTO_BOOK_FORMATS[format];
  return { x: rect.x / f.width, y: rect.y / f.height, w: rect.w / f.width, h: rect.h / f.height };
}

/** The slots of every page, with only the photos the owner may still see. */
async function loadSlots(userId: number, bookId: number): Promise<SlotPhotoRow[]> {
  return dbAll<SlotPhotoRow>(
    db.select({
      page_id: photoBookSlot.page_id,
      slot: photoBookSlot.slot,
      photo_id: photoBookSlot.photo_id,
      filename: photos.filename,
      width: photos.width,
      height: photos.height,
      auto_crop: photos.auto_crop,
      taken_at: photos.taken_at,
      quality: photos.ai_quality_score,
      aesthetic: aestheticScoreSql,
      city: photos.location_city,
    })
      .from(photoBookSlot)
      .innerJoin(photoBookPage, eq(photoBookPage.id, photoBookSlot.page_id))
      .innerJoin(photos, eq(photos.id, photoBookSlot.photo_id))
      .where(and(eq(photoBookPage.book_id, bookId), accessiblePhotoCondition(userId)))
      .orderBy(asc(photoBookSlot.page_id), asc(photoBookSlot.slot)),
  );
}

/** Write a page's slots and layout from a draft; a photo page left empty goes. */
async function writePage(pageId: number, kind: PageKind, format: PhotoBookFormat, list: BookPhoto[]): Promise<void> {
  const draft = relayoutPage(format, kind, list);
  await dbExec(db.delete(photoBookSlot).where(eq(photoBookSlot.page_id, pageId)));
  if (!draft) {
    await dbExec(db.delete(photoBookPage).where(eq(photoBookPage.id, pageId)));
    return;
  }
  // A new photo count is the rule's to lay out again; nobody chose this layout yet.
  await dbExec(db.update(photoBookPage).set({ layout: draft.layout, layout_source: "rule", layout_origin: "rule", rule_layout: draft.layout, layout_reason: null })
    .where(eq(photoBookPage.id, pageId)));
  if (draft.photoIds.length) {
    await dbExec(db.insert(photoBookSlot).values(draft.photoIds.map((photo_id, slot) => ({ page_id: pageId, slot, photo_id }))));
  }
}

export interface LoadedPage {
  id: number;
  position: number;
  chapter_id: number | null;
  kind: PageKind;
  layout: BookLayout;
  captions: boolean | null;
  layout_source: PhotoBookTextSource;
  layout_reason: string | null;
  photos: SlotPhotoRow[];
}

export interface LoadedCaption {
  text: string;
  source: "llm" | "user";
}

export interface LoadedBook {
  book: typeof photoBook.$inferSelect;
  format: PhotoBookFormat;
  chapters: PhotoBookChapterView[];
  pages: LoadedPage[];
  cover: SlotPhotoRow | null;
  /** By photo id. */
  captions: Map<number, LoadedCaption>;
}

/** Whether `page` shows captions: its own setting, else the book's, and only when one of its photos has one. */
export function pageCaptioned(loaded: LoadedBook, page: LoadedPage): boolean {
  const on = page.captions ?? bookSettings(loaded.book.settings).captions;
  return on && page.photos.some((p) => loaded.captions.has(p.photo_id));
}

/**
 * The book with its pages in order. A page whose photos no longer fill its
 * layout (a photo was deleted or is no longer visible) is laid out again for
 * what is left, and an empty photo page goes, before anything is returned.
 */
export async function loadPhotoBook(userId: number, bookId: number): Promise<LoadedBook> {
  const book = await ownedBook(userId, bookId);
  const format: PhotoBookFormat = isPhotoBookFormat(book.format) ? book.format : "a4-landscape";
  const chapters = await dbAll<PhotoBookChapterView>(
    db.select({
      id: photoBookChapter.id,
      position: photoBookChapter.position,
      title: photoBookChapter.title,
      subtitle: photoBookChapter.subtitle,
      starts_at: photoBookChapter.starts_at,
      ends_at: photoBookChapter.ends_at,
      title_source: photoBookChapter.title_source,
      title_suggestion: photoBookChapter.title_suggestion,
    }).from(photoBookChapter).where(eq(photoBookChapter.book_id, bookId)).orderBy(asc(photoBookChapter.position)),
  );
  const captionRows = await dbAll<{ photo_id: number; text: string; source: "llm" | "user" }>(
    db.select({ photo_id: photoBookCaption.photo_id, text: photoBookCaption.text, source: photoBookCaption.source })
      .from(photoBookCaption).where(eq(photoBookCaption.book_id, bookId)),
  );
  const captions = new Map(captionRows.map((c) => [c.photo_id, { text: c.text, source: c.source }]));

  for (let attempt = 0; attempt < 2; attempt++) {
    const pageRows = await dbAll<{
      id: number;
      position: number;
      chapter_id: number | null;
      kind: PageKind;
      layout: string;
      captions: boolean | null;
      layout_source: PhotoBookTextSource;
      layout_reason: string | null;
    }>(
      db.select({
        id: photoBookPage.id,
        position: photoBookPage.position,
        chapter_id: photoBookPage.chapter_id,
        kind: photoBookPage.kind,
        layout: photoBookPage.layout,
        captions: photoBookPage.captions,
        layout_source: photoBookPage.layout_source,
        layout_reason: photoBookPage.layout_reason,
      }).from(photoBookPage).where(eq(photoBookPage.book_id, bookId)).orderBy(asc(photoBookPage.position), asc(photoBookPage.id)),
    );
    const slots = await loadSlots(userId, bookId);
    const byPage = new Map<number, SlotPhotoRow[]>();
    for (const s of slots) {
      const list = byPage.get(s.page_id) ?? [];
      list.push(s);
      byPage.set(s.page_id, list);
    }

    const pages: LoadedPage[] = [];
    let repaired = false;
    for (const r of pageRows) {
      const list = byPage.get(r.id) ?? [];
      const layout = findBookLayout(r.kind, list.length, r.layout);
      if (!layout) {
        await writePage(r.id, r.kind, format, list.map(toBookPhoto));
        repaired = true;
        continue;
      }
      pages.push({
        id: r.id,
        position: r.position,
        chapter_id: r.chapter_id,
        kind: r.kind,
        layout,
        captions: r.captions,
        layout_source: r.layout_source,
        layout_reason: r.layout_reason,
        photos: list,
      });
    }
    if (repaired) continue;

    let cover: SlotPhotoRow | null = null;
    if (book.cover_photo_id != null) cover = slots.find((s) => s.photo_id === book.cover_photo_id) ?? null;
    return { book, format, chapters, pages, cover, captions };
  }
  throw APIError.internal("photo book pages could not be repaired");
}

export async function getPhotoBookView(userId: number, bookId: number): Promise<PhotoBookView> {
  const loaded = await loadPhotoBook(userId, bookId);
  const { book, format } = loaded;
  const f = PHOTO_BOOK_FORMATS[format];
  const settings = bookSettings(book.settings);
  let lowDpi = 0;
  const photoIds = new Set<number>();
  const pages: PhotoBookPageView[] = loaded.pages.map((p) => {
    const tr = textRect(format, p.layout);
    const captioned = pageCaptioned(loaded, p);
    return {
      id: p.id,
      position: p.position,
      chapter_id: p.chapter_id,
      kind: p.kind,
      layout: p.layout.id,
      layout_options: bookLayouts(p.kind, p.photos.length).map((l) => ({ id: l.id, name: l.name })),
      full_bleed: !!p.layout.fullBleed,
      text_rect: tr ? share(tr, format) : null,
      captions: captioned,
      captions_override: p.captions,
      layout_source: p.layout_source,
      layout_reason: p.layout_reason,
      slots: p.photos.map((s, i) => {
        const geo = slotGeometry(format, p.layout, p.layout.cells[i], captioned);
        const rect = geo.image;
        const dpi = slotDpi(s.width, s.height, rect);
        const caption = loaded.captions.get(s.photo_id) ?? null;
        const low = dpi != null && dpi < MIN_PRINT_DPI;
        if (low) lowDpi += 1;
        photoIds.add(s.photo_id);
        return {
          slot: i,
          photo_id: s.photo_id,
          filename: s.filename,
          auto_crop: s.auto_crop,
          rect: share(rect, format),
          dpi: dpi == null ? null : Math.round(dpi),
          low_dpi: low,
          caption: caption?.text ?? null,
          caption_source: caption?.source ?? null,
          caption_rect: geo.caption ? share(geo.caption, format) : null,
          caption_overlay: geo.overlay,
        };
      }),
    };
  });
  return {
    id: book.id,
    title: book.title,
    subtitle: book.subtitle,
    format,
    width_mm: f.width,
    height_mm: f.height,
    cover_photo_id: loaded.cover?.photo_id ?? null,
    cover_filename: loaded.cover?.filename ?? null,
    cover_auto_crop: loaded.cover?.auto_crop ?? null,
    settings,
    source: book.source,
    page_count: pages.length,
    photo_count: photoIds.size,
    spine_mm: spineWidthMm(pages.length + (pages.length % 2), settings.paper_mm),
    low_dpi_count: lowDpi,
    chapters: loaded.chapters,
    pages,
    created_at: book.created_at,
    updated_at: book.updated_at,
  };
}

export async function listPhotoBooks(userId: number): Promise<PhotoBookSummary[]> {
  const rows = await dbAll<{
    id: number;
    title: string;
    subtitle: string | null;
    format: string;
    updated_at: string;
    page_count: number;
    photo_count: number;
    cover_filename: string | null;
  }>(
    db.select({
      id: photoBook.id,
      title: photoBook.title,
      subtitle: photoBook.subtitle,
      format: photoBook.format,
      updated_at: photoBook.updated_at,
      page_count: sql<number>`(SELECT COUNT(*)::int FROM ${photoBookPage} pg WHERE pg.book_id = ${photoBook.id})`,
      photo_count: sql<number>`(SELECT COUNT(DISTINCT s.photo_id)::int FROM ${photoBookSlot} s JOIN ${photoBookPage} pg ON pg.id = s.page_id WHERE pg.book_id = ${photoBook.id})`,
      cover_filename: sql<string | null>`(SELECT p.filename FROM ${photos} p WHERE p.id = ${photoBook.cover_photo_id} AND ${accessiblePhotoConditionFor(userId, sql`p.id`, sql`p.user_id`)})`,
    }).from(photoBook).where(eq(photoBook.user_id, userId)).orderBy(sql`${photoBook.updated_at} DESC`),
  );
  return rows.map((r) => ({ ...r, format: isPhotoBookFormat(r.format) ? r.format : "a4-landscape" }));
}

// ── edits ───────────────────────────────────────────────────────────────

export interface UpdatePhotoBookInput {
  title?: string;
  subtitle?: string | null;
  format?: PhotoBookFormat;
  coverPhotoId?: number | null;
  settings?: PhotoBookSettings;
}

export async function updatePhotoBook(userId: number, bookId: number, input: UpdatePhotoBookInput): Promise<void> {
  const book = await ownedBook(userId, bookId);
  const values: Partial<typeof photoBook.$inferInsert> = {};
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (!t) throw APIError.invalidArgument("title must not be empty");
    values.title = t;
  }
  if (input.subtitle !== undefined) values.subtitle = input.subtitle?.trim() || null;
  if (input.format !== undefined) {
    if (!isPhotoBookFormat(input.format)) throw APIError.invalidArgument(`unknown format ${String(input.format)}`);
    values.format = input.format;
  }
  if (input.coverPhotoId !== undefined) {
    if (input.coverPhotoId !== null) {
      const inBook = (await loadSlots(userId, bookId)).some((s) => s.photo_id === input.coverPhotoId);
      if (!inBook) throw APIError.invalidArgument("the cover must be a photo of the book");
    }
    values.cover_photo_id = input.coverPhotoId;
  }
  if (input.settings !== undefined) values.settings = bookSettings({ ...book.settings, ...input.settings });
  await dbExec(db.update(photoBook).set({ ...values, updated_at: sql`now()` }).where(eq(photoBook.id, bookId)));
}

export async function updatePhotoBookChapter(
  userId: number,
  bookId: number,
  chapterId: number,
  input: { title?: string; subtitle?: string | null },
): Promise<void> {
  await ownedBook(userId, bookId);
  const values: Partial<typeof photoBookChapter.$inferInsert> = {};
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (!t) throw APIError.invalidArgument("title must not be empty");
    values.title = t;
    values.title_source = "user";
  }
  if (input.subtitle !== undefined) values.subtitle = input.subtitle?.trim() || null;
  const res = await dbExec(db.update(photoBookChapter).set(values)
    .where(and(eq(photoBookChapter.id, chapterId), eq(photoBookChapter.book_id, bookId))));
  if (!res.changes) throw APIError.notFound("chapter not found");
  await touch(bookId);
}

async function ownedPage(userId: number, bookId: number, pageId: number) {
  const loaded = await loadPhotoBook(userId, bookId);
  const page = loaded.pages.find((p) => p.id === pageId);
  if (!page) throw APIError.notFound("page not found");
  return { loaded, page };
}

/** Switch a page to another layout for the same number of photos; the photos keep their order. */
export async function setPhotoBookPageLayout(userId: number, bookId: number, pageId: number, layoutId: string): Promise<void> {
  const { page } = await ownedPage(userId, bookId, pageId);
  if (!findBookLayout(page.kind, page.photos.length, layoutId)) {
    const known = bookLayouts(page.kind, page.photos.length).map((l) => l.id).join(", ");
    throw APIError.invalidArgument(`unknown layout ${layoutId} for ${page.photos.length} photos; one of ${known}`);
  }
  if (layoutId === page.layout.id) return;
  // `layout_origin` keeps who picked the layout the user turned away from.
  await dbExec(db.update(photoBookPage).set({ layout: layoutId, layout_source: "user" }).where(eq(photoBookPage.id, pageId)));
  await touch(bookId);
}

/** Captions on one page: true or false, or null to follow the book. */
export async function setPhotoBookPageCaptions(userId: number, bookId: number, pageId: number, captions: boolean | null): Promise<void> {
  await ownedPage(userId, bookId, pageId);
  await dbExec(db.update(photoBookPage).set({ captions }).where(eq(photoBookPage.id, pageId)));
  await touch(bookId);
}

/** The user's caption for a photo of the book; empty text removes it. */
export async function setPhotoBookCaption(userId: number, bookId: number, photoId: number, text: string | null): Promise<void> {
  await ownedBook(userId, bookId);
  const inBook = (await loadSlots(userId, bookId)).some((s) => s.photo_id === photoId);
  if (!inBook) throw APIError.notFound("photo not in this book");
  const t = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!t) {
    await dbExec(db.delete(photoBookCaption).where(and(eq(photoBookCaption.book_id, bookId), eq(photoBookCaption.photo_id, photoId))));
  } else {
    if (t.length > 300) throw APIError.invalidArgument("caption is longer than 300 characters");
    const values = { book_id: bookId, photo_id: photoId, text: t, source: "user" as const, model: null, created_at: new Date().toISOString() };
    await db.insert(photoBookCaption).values(values)
      .onConflictDoUpdate({ target: [photoBookCaption.book_id, photoBookCaption.photo_id], set: values });
  }
  await touch(bookId);
}

/** Take the model's proposed title for a chapter. */
export async function acceptPhotoBookChapterSuggestion(userId: number, bookId: number, chapterId: number): Promise<void> {
  await ownedBook(userId, bookId);
  const ch = await dbFirst<{ title_suggestion: string | null }>(
    db.select({ title_suggestion: photoBookChapter.title_suggestion }).from(photoBookChapter)
      .where(and(eq(photoBookChapter.id, chapterId), eq(photoBookChapter.book_id, bookId))),
  );
  if (!ch) throw APIError.notFound("chapter not found");
  if (!ch.title_suggestion) throw APIError.failedPrecondition("no suggestion for this chapter");
  await dbExec(db.update(photoBookChapter).set({ title: ch.title_suggestion, title_source: "llm" }).where(eq(photoBookChapter.id, chapterId)));
  await touch(bookId);
}

/** Take one photo out of a page; the page is laid out again for the rest. */
export async function removePhotoFromBookPage(userId: number, bookId: number, pageId: number, photoId: number): Promise<void> {
  const { loaded, page } = await ownedPage(userId, bookId, pageId);
  if (!page.photos.some((p) => p.photo_id === photoId)) throw APIError.notFound("photo not on this page");
  const rest = page.photos.filter((p) => p.photo_id !== photoId).map(toBookPhoto);
  await writePage(pageId, page.kind, loaded.format, rest);
  if (loaded.book.cover_photo_id === photoId) {
    const stillInBook = loaded.pages.some((p) => p.photos.some((s) => s.photo_id === photoId && p.id !== pageId));
    if (!stillInBook) await dbExec(db.update(photoBook).set({ cover_photo_id: null }).where(eq(photoBook.id, bookId)));
  }
  await touch(bookId);
}

export async function deletePhotoBook(userId: number, bookId: number): Promise<void> {
  await ownedBook(userId, bookId);
  await dbExec(db.delete(photoBook).where(eq(photoBook.id, bookId)));
}
