import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { albumPhotos, albums, faces, photoBook, photoCuration, photos, users } from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";
import {
  CELL_GAP_MM,
  PAGE_MARGIN_MM,
  PHOTO_BOOK_FORMATS,
  bookLayouts,
  buildChapterPages,
  buildChapters,
  cellRect,
  chapterSubtitle,
  chooseLayout,
  formatDayRange,
  isRecognisableFace,
  limitPhotos,
  photoScore,
  relayoutPage,
  slotDpi,
  spineWidthMm,
  type BookPhoto,
} from "./photo-book-layout";
import {
  createPhotoBook,
  deletePhotoBook,
  getPhotoBookView,
  listPhotoBooks,
  loadPhotoBook,
  rebuildPhotoBook,
  removePhotoFromBookPage,
  setPhotoBookPageLayout,
  updatePhotoBook,
  updatePhotoBookChapter,
} from "./photo-book.service";
import { renderCoverPdf, renderHomePdf, renderInsidePdf, type RenderBook } from "./photo-book-pdf";
import { toRenderBook } from "./photo-book-export";

function photo(id: number, takenAt: string | null, opts: Partial<BookPhoto> = {}): BookPhoto {
  return { id, takenAt, width: 3000, height: 2000, score: 50, city: null, ...opts };
}

describe("photo book geometry", () => {
  it("keeps cells inside the content box with one gap between neighbours", () => {
    const [side] = bookLayouts("photos", 2);
    const f = PHOTO_BOOK_FORMATS["a4-landscape"];
    const a = cellRect("a4-landscape", side, side.cells[0]);
    const b = cellRect("a4-landscape", side, side.cells[1]);
    expect(a.x).toBeCloseTo(PAGE_MARGIN_MM);
    expect(b.x + b.w).toBeCloseTo(f.width - PAGE_MARGIN_MM);
    expect(b.x - (a.x + a.w)).toBeCloseTo(CELL_GAP_MM);
    expect(a.y).toBeCloseTo(PAGE_MARGIN_MM);
    expect(a.h).toBeCloseTo(f.height - 2 * PAGE_MARGIN_MM);
  });

  it("covers the whole page for a full-bleed layout", () => {
    const full = bookLayouts("photos", 1).find((l) => l.id === "full")!;
    expect(cellRect("square-21", full, full.cells[0])).toEqual({ x: 0, y: 0, w: 210, h: 210 });
  });

  it("reports the dpi from the side the cover crop keeps", () => {
    // 254 mm = 10 in wide, 127 mm = 5 in high: a 3:2 photo of 3000 × 2000 px
    // in that 2:1 cell is cut at top and bottom, so 3000 px over 10 in.
    expect(slotDpi(3000, 2000, { x: 0, y: 0, w: 254, h: 127 })).toBeCloseTo(300);
    // In a 1:1 cell of 5 in it is cut at the sides: 2000 px over 5 in.
    expect(slotDpi(3000, 2000, { x: 0, y: 0, w: 127, h: 127 })).toBeCloseTo(400);
    expect(slotDpi(null, 2000, { x: 0, y: 0, w: 10, h: 10 })).toBeNull();
  });

  it("makes the spine from sheets, not pages", () => {
    expect(spineWidthMm(40, 0.12)).toBeCloseTo(2.4);
    expect(spineWidthMm(41, 0.12)).toBeCloseTo(2.5);
  });
});

describe("photo book selection rules", () => {
  it("counts only large, sharp faces as recognisable", () => {
    expect(isRecognisableFace({ width: 0.1, height: 0.1, sharpness: 0.8 })).toBe(true);
    expect(isRecognisableFace({ width: 0.1, height: 0.1, sharpness: null })).toBe(true);
    expect(isRecognisableFace({ width: 0.03, height: 0.03, sharpness: 0.9 })).toBe(false);
    expect(isRecognisableFace({ width: 0.2, height: 0.2, sharpness: 0.1 })).toBe(false);
  });

  it("scores by aesthetics, then quality", () => {
    expect(photoScore(0.7, 0.2)).toBeCloseTo(70);
    expect(photoScore(null, 0.4)).toBeCloseTo(40);
    expect(photoScore(null, null)).toBe(50);
  });

  it("keeps the best photos and puts them back in time order", () => {
    const list = [photo(1, "2024-06-03 10:00:00", { score: 10 }), photo(2, "2024-06-01 10:00:00", { score: 90 }), photo(3, "2024-06-02 10:00:00", { score: 80 })];
    expect(limitPhotos(list, 2).map((p) => p.id)).toEqual([2, 3]);
    expect(limitPhotos(list, null).map((p) => p.id)).toEqual([2, 3, 1]);
  });
});

describe("photo book chapters", () => {
  it("formats ranges and durations", () => {
    expect(formatDayRange("2024-06-01", "2024-06-03")).toBe("1.–3. Juni 2024");
    expect(formatDayRange("2024-05-30", "2024-06-02")).toBe("30. Mai – 2. Juni 2024");
    expect(chapterSubtitle("2024-06-01", "2024-06-03")).toBe("3 Tage, 1.–3. Juni 2024");
    expect(chapterSubtitle("2024-06-03", "2024-06-03")).toBe("Montag, 3. Juni 2024");
  });

  it("makes one chapter per day for a short span and folds small days into the one before", () => {
    const list = [
      ...[1, 2, 3, 4].map((i) => photo(i, `2024-06-01 0${i}:00:00`, { city: "Musterstadt" })),
      photo(5, "2024-06-02 09:00:00"),
      ...[6, 7, 8, 9].map((i) => photo(i, `2024-06-03 0${i - 5}:00:00`)),
      photo(10, null),
    ];
    const chapters = buildChapters(list);
    expect(chapters.map((c) => c.photos.map((p) => p.id))).toEqual([[1, 2, 3, 4, 5], [6, 7, 8, 9], [10]]);
    expect(chapters[0].title).toBe("Tag 1–2 · Musterstadt");
    expect(chapters[0].subtitle).toBe("2 Tage, 1.–2. Juni 2024");
    expect(chapters[1].title).toBe("Tag 3");
    expect(chapters[2].title).toBe("Ohne Datum");
  });

  it("goes by month for a long span", () => {
    const list = [
      ...[1, 2, 3, 4].map((i) => photo(i, `2024-01-1${i} 10:00:00`)),
      ...[5, 6, 7, 8].map((i) => photo(i, `2024-03-1${i - 4} 10:00:00`)),
    ];
    expect(buildChapters(list).map((c) => c.title)).toEqual(["Januar 2024", "März 2024"]);
  });
});

describe("photo book pages", () => {
  it("opens a chapter with its best photo and places every photo once", () => {
    const list = Array.from({ length: 17 }, (_, i) => photo(i + 1, `2024-06-01 10:${String(i).padStart(2, "0")}:00`, {
      score: i === 6 ? 95 : 40 + i,
      width: i % 3 === 0 ? 2000 : 3000,
      height: i % 3 === 0 ? 3000 : 2000,
    }));
    const pages = buildChapterPages("a4-landscape", list);
    expect(pages[0]).toMatchObject({ kind: "opener", photoIds: [7] });
    const placed = pages.flatMap((p) => p.photoIds);
    expect(placed.sort((a, b) => a - b)).toEqual(list.map((p) => p.id));
    for (const p of pages) {
      expect(bookLayouts(p.kind, p.photoIds.length).some((l) => l.id === p.layout)).toBe(true);
    }
  });

  it("puts the best photo in the largest cell", () => {
    const list = [photo(1, null, { score: 10 }), photo(2, null, { score: 90 }), photo(3, null, { score: 20 })];
    const choice = chooseLayout("a4-landscape", list)!;
    const big = choice.layout.cells.reduce((best, c, i, all) => (c.w * c.h > all[best].w * all[best].h ? i : best), 0);
    if (choice.layout.cells.some((c) => Math.abs(c.w * c.h - choice.layout.cells[big].w * choice.layout.cells[big].h) > 1e-6)) {
      expect(choice.photos[big].id).toBe(2);
    }
  });

  it("re-lays a page for fewer photos and keeps an opener without its photo", () => {
    expect(relayoutPage("a4-landscape", "photos", [photo(1, null)])?.layout).toBe("full");
    expect(relayoutPage("a4-landscape", "photos", [photo(1, null, { width: 2000, height: 3000 })])?.layout).toBe("single");
    expect(relayoutPage("a4-landscape", "photos", [])).toBeNull();
    expect(relayoutPage("a4-landscape", "opener", [])).toEqual({ kind: "opener", layout: "opener-text", photoIds: [] });
  });
});

describe("photo book service", () => {
  let user: { id: number };
  let other: { id: number };

  beforeEach(async () => {
    await db.delete(photoBook);
    await db.delete(albumPhotos);
    await db.delete(albums);
    await db.delete(faces);
    await db.delete(photoCuration);
    await db.delete(photos);
    await db.delete(users);
    user = await createUserLogic({ email: "book@test.com", name: "U", password: "pw" });
    other = await createUserLogic({ email: "other@test.com", name: "O", password: "pw" });
  });

  let seq = 0;
  async function upload(owner: number, takenAt: string, values: Partial<typeof photos.$inferInsert> = {}) {
    seq += 1;
    const p = await service.uploadPhotoLogic(owner, { data: Buffer.from([seq % 256, seq >> 8, 7]), name: `p${seq}.jpg`, mimeType: "image/jpeg" });
    await db.update(photos).set({ taken_at: takenAt, width: 3000, height: 2000, ...values }).where(eq(photos.id, p.id));
    return p;
  }

  it("builds from a selection with the narrowing and leaves out what the owner may not see", async () => {
    const good = await upload(user.id, "2024-06-01 10:00:00", { ai_quality_score: 0.8 });
    const weak = await upload(user.id, "2024-06-01 11:00:00", { ai_quality_score: 0.2 });
    const face = await upload(user.id, "2024-06-01 12:00:00", { ai_quality_score: 0.9 });
    const smallFace = await upload(user.id, "2024-06-01 13:00:00", { ai_quality_score: 0.9 });
    const hidden = await upload(user.id, "2024-06-01 14:00:00", { ai_quality_score: 0.9 });
    const foreign = await upload(other.id, "2024-06-01 15:00:00", { ai_quality_score: 0.9 });
    await db.insert(faces).values([
      { photo_id: face.id, bbox: JSON.stringify({ x: 0.4, y: 0.3, width: 0.2, height: 0.25 }), embedding: "[]", sharpness: 0.7 },
      { photo_id: smallFace.id, bbox: JSON.stringify({ x: 0.4, y: 0.3, width: 0.02, height: 0.03 }), embedding: "[]", sharpness: 0.7 },
    ]);
    await db.insert(photoCuration).values({ user_id: user.id, photo_id: hidden.id, status: "hidden" });

    const id = await createPhotoBook(user.id, {
      title: "Sommer",
      photoIds: [good.id, weak.id, face.id, smallFace.id, hidden.id, foreign.id],
      qualityMin: 50,
      withoutRecognisableFaces: true,
    });
    const view = await getPhotoBookView(user.id, id);
    const ids = view.pages.flatMap((p) => p.slots.map((s) => s.photo_id)).sort((a, b) => a - b);
    expect(ids).toEqual([good.id, smallFace.id].sort((a, b) => a - b));
    expect(view.pages[0].kind).toBe("opener");
    expect(view.chapters).toHaveLength(1);
    expect(view.cover_photo_id).not.toBeNull();
    expect(view.settings).toEqual({ bleed_mm: 3, crop_marks: false, spreads: true, paper_mm: 0.12, captions: false });

    await expect(getPhotoBookView(other.id, id)).rejects.toThrow(/not found/);
    expect((await listPhotoBooks(user.id)).map((b) => b.title)).toEqual(["Sommer"]);
    expect(await listPhotoBooks(other.id)).toEqual([]);
  });

  it("refuses a selection that the narrowing empties", async () => {
    const p = await upload(user.id, "2024-06-01 10:00:00", { ai_quality_score: 0.1 });
    await expect(createPhotoBook(user.id, { title: "Leer", photoIds: [p.id], qualityMin: 50 })).rejects.toThrow(/no photos/);
  });

  it("builds from an album the user can see, and not from one they cannot", async () => {
    const album = await service.createAlbumLogic(user.id, { name: "A" });
    const list = [];
    for (let i = 0; i < 6; i++) list.push(await upload(user.id, `2024-06-0${1 + (i % 2)} 1${i}:00:00`));
    for (const p of list) await service.addPhotoToAlbumLogic(user.id, { albumId: album.id, photoId: p.id });
    const id = await createPhotoBook(user.id, { title: "Album", albumId: album.id, format: "square-21" });
    const view = await getPhotoBookView(user.id, id);
    expect(view.photo_count).toBe(6);
    expect(view.format).toBe("square-21");
    await expect(createPhotoBook(other.id, { title: "Fremd", albumId: album.id })).rejects.toThrow(/album not found/);
  });

  it("edits titles, layouts, cover and settings, and re-lays a page when a photo leaves", async () => {
    const list = [];
    for (let i = 0; i < 8; i++) list.push(await upload(user.id, `2024-06-01 1${i}:00:00`, { ai_quality_score: 0.5 + i / 100 }));
    const id = await createPhotoBook(user.id, { title: "Buch", photoIds: list.map((p) => p.id) });
    let view = await getPhotoBookView(user.id, id);

    await updatePhotoBookChapter(user.id, id, view.chapters[0].id, { title: "Am See" });
    await updatePhotoBook(user.id, id, { subtitle: "2024", settings: { bleed_mm: 5, crop_marks: true } });
    view = await getPhotoBookView(user.id, id);
    expect(view.chapters[0].title).toBe("Am See");
    expect(view.subtitle).toBe("2024");
    expect(view.settings).toMatchObject({ bleed_mm: 5, crop_marks: true, spreads: true });

    const multi = view.pages.find((p) => p.slots.length > 1)!;
    const other2 = multi.layout_options.find((o) => o.id !== multi.layout)!;
    await setPhotoBookPageLayout(user.id, id, multi.id, other2.id);
    await expect(setPhotoBookPageLayout(user.id, id, multi.id, "nope")).rejects.toThrow(/unknown layout/);
    view = await getPhotoBookView(user.id, id);
    expect(view.pages.find((p) => p.id === multi.id)!.layout).toBe(other2.id);

    const before = multi.slots.length;
    await removePhotoFromBookPage(user.id, id, multi.id, multi.slots[0].photo_id);
    view = await getPhotoBookView(user.id, id);
    expect(view.pages.find((p) => p.id === multi.id)!.slots).toHaveLength(before - 1);

    const anyPhoto = view.pages[view.pages.length - 1].slots[0].photo_id;
    await updatePhotoBook(user.id, id, { coverPhotoId: anyPhoto });
    expect((await getPhotoBookView(user.id, id)).cover_photo_id).toBe(anyPhoto);
    await expect(updatePhotoBook(user.id, id, { coverPhotoId: 999999 })).rejects.toThrow(/cover/);
  });

  it("repairs pages whose photo was deleted, and rebuilds from the source", async () => {
    const list = [];
    for (let i = 0; i < 5; i++) list.push(await upload(user.id, `2024-06-01 1${i}:00:00`));
    const id = await createPhotoBook(user.id, { title: "Buch", photoIds: list.map((p) => p.id) });
    const view = await getPhotoBookView(user.id, id);
    const multi = view.pages.find((p) => p.slots.length > 1)!;
    await db.delete(photos).where(eq(photos.id, multi.slots[0].photo_id));

    const repaired = await getPhotoBookView(user.id, id);
    expect(repaired.photo_count).toBe(4);
    for (const p of repaired.pages) {
      expect(p.layout_options.some((o) => o.id === p.layout)).toBe(true);
    }

    await rebuildPhotoBook(user.id, id);
    const rebuilt = await getPhotoBookView(user.id, id);
    expect(rebuilt.photo_count).toBe(4);
    await deletePhotoBook(user.id, id);
    await expect(getPhotoBookView(user.id, id)).rejects.toThrow(/not found/);
  });

  it("hands the PDF the chapter titles on openers", async () => {
    const list = [];
    for (let i = 0; i < 4; i++) list.push(await upload(user.id, `2024-06-01 1${i}:00:00`));
    const id = await createPhotoBook(user.id, { title: "Buch", photoIds: list.map((p) => p.id) });
    const book = toRenderBook(await loadPhotoBook(user.id, id));
    expect(book.pages[0].chapterTitle).toBe("1. Juni 2024");
    expect(book.pages.slice(1).every((p) => p.chapterTitle === null)).toBe(true);
    expect(book.pages.flatMap((p) => p.slots).length).toBe(4);
  });
});

describe("photo book PDF", () => {
  async function images(dir: string) {
    const files: Record<number, string> = {};
    const sizes: [number, number][] = [[600, 400], [400, 600], [500, 500], [600, 400], [600, 400]];
    for (let i = 0; i < sizes.length; i++) {
      const f = path.join(dir, `${i + 1}.jpg`);
      await sharp({ create: { width: sizes[i][0], height: sizes[i][1], channels: 3, background: { r: 40 * i, g: 120, b: 200 } } }).jpeg().toFile(f);
      files[i + 1] = f;
    }
    return files;
  }

  function pageCount(file: string): number {
    return (fs.readFileSync(file, "latin1").match(/\/Type \/Page\b/g) ?? []).length;
  }

  function mediaBoxes(file: string): number[][] {
    return [...fs.readFileSync(file, "latin1").matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
  }

  it("renders a book for home and for a print shop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-book-"));
    const files = await images(dir);
    const layouts = (n: number, id: string) => bookLayouts("photos", n).find((l) => l.id === id)!;
    const book: RenderBook = {
      format: "a4-landscape",
      title: "Sommer am See",
      subtitle: "Juni 2024",
      cover: { photoId: 1, focal: null },
      pages: [
        { layout: bookLayouts("opener", 1)[0], chapterTitle: "Tag 1 · Musterstadt", chapterSubtitle: "Samstag, 1. Juni 2024", slots: [{ photoId: 1, focal: null }] },
        { layout: layouts(3, "hero-left"), chapterTitle: null, chapterSubtitle: null, slots: [2, 3, 4].map((photoId) => ({ photoId, focal: null })) },
        { layout: layouts(1, "full"), chapterTitle: null, chapterSubtitle: null, slots: [{ photoId: 5, focal: { x: 0.5, y: 0.5 } }] },
      ],
      bleedMm: 3,
      cropMarks: true,
      spreads: true,
      paperMm: 0.12,
    };
    const load = async (id: number) => files[id] ?? null;
    let progress = 0;

    const home = path.join(dir, "book.pdf");
    await renderHomePdf(book, load, home, (done, total) => { progress = done / total; });
    expect(fs.readFileSync(home).subarray(0, 4).toString()).toBe("%PDF");
    expect(pageCount(home)).toBe(4);
    expect(progress).toBe(1);

    const inside = path.join(dir, "inside.pdf");
    await renderInsidePdf(book, load, inside);
    expect(pageCount(inside)).toBe(2); // 3 pages + 1 empty, as two spreads
    const mm = (p: number) => (p * 25.4) / 72;
    const [w, h] = mediaBoxes(inside)[0].slice(2);
    expect(mm(w)).toBeCloseTo(2 * 297 + 2 * (3 + 6), 0);
    expect(mm(h)).toBeCloseTo(210 + 2 * (3 + 6), 0);

    const cover = path.join(dir, "cover.pdf");
    await renderCoverPdf(book, load, cover);
    expect(pageCount(cover)).toBe(1);
    const [cw] = mediaBoxes(cover)[0].slice(2);
    expect(mm(cw)).toBeCloseTo(2 * 297 + spineWidthMm(4, 0.12) + 2 * (3 + 6), 0);

    await renderInsidePdf({ ...book, spreads: false, cropMarks: false, bleedMm: 0 }, async () => null, inside);
    expect(pageCount(inside)).toBe(4);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
