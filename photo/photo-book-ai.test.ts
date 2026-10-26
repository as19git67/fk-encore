import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import db from "../db/database";
import {
  faces,
  persons,
  photoBook,
  photoBookCaption,
  photoBookPage,
  photoCuration,
  photoPoiMatches,
  photos,
  poiReferences,
  userFaceAssignments,
  users,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";
import { CAPTION_STRIP_MM, PAGE_MARGIN_MM, bookLayouts, cellRect, rankLayouts, slotGeometry, type BookPhoto } from "./photo-book-layout";
import {
  MAX_CAPTION_LENGTH,
  articleExtract,
  buildCaptionPrompt,
  buildLayoutPrompt,
  captionNamesAFact,
  hasConcreteFacts,
  parseCaption,
  parseChapterTitle,
  parseLayoutPick,
} from "./photo-book-prompts";
import {
  acceptPhotoBookChapterSuggestion,
  createPhotoBook,
  getPhotoBookView,
  loadPhotoBook,
  setPhotoBookCaption,
  setPhotoBookPageCaptions,
  setPhotoBookPageLayout,
  updatePhotoBook,
  updatePhotoBookChapter,
} from "./photo-book.service";
import { layoutPickStats, runPhotoBookAi, type PhotoBookAiDeps, type PhotoBookAiJob } from "./photo-book-ai";
import type { LlmPrompt } from "./photo-book-prompts";
import { toRenderBook } from "./photo-book-export";
import { renderHomePdf } from "./photo-book-pdf";

function photo(id: number, opts: Partial<BookPhoto> = {}): BookPhoto {
  return { id, takenAt: `2024-06-01 1${id}:00:00`, width: 3000, height: 2000, score: 50, city: null, ...opts };
}

describe("photo book captions: geometry and prompts", () => {
  it("takes the caption strip from the bottom of a framed cell", () => {
    const [side] = bookLayouts("photos", 2);
    const cell = cellRect("a4-landscape", side, side.cells[0]);
    const geo = slotGeometry("a4-landscape", side, side.cells[0], true);
    expect(geo.overlay).toBe(false);
    expect(geo.image.h).toBeCloseTo(cell.h - CAPTION_STRIP_MM);
    expect(geo.caption!.y + geo.caption!.h).toBeCloseTo(cell.y + cell.h);
    expect(slotGeometry("a4-landscape", side, side.cells[0], false)).toEqual({ image: cell, caption: null, overlay: false });
  });

  it("lays a full-bleed caption over the photo, inside the margin", () => {
    const full = bookLayouts("photos", 1).find((l) => l.id === "full")!;
    const geo = slotGeometry("square-21", full, full.cells[0], true);
    expect(geo.overlay).toBe(true);
    expect(geo.image).toEqual({ x: 0, y: 0, w: 210, h: 210 });
    expect(geo.caption!.x).toBe(PAGE_MARGIN_MM);
    expect(geo.caption!.y + geo.caption!.h).toBeCloseTo(210 - PAGE_MARGIN_MM);
  });

  it("hands the model only the facts it has", () => {
    const p = buildCaptionPrompt({
      when: "Samstag, 1. Juni 2024, 10:00 Uhr",
      place: "Musterstadt, Beispielland",
      poi: { name: "Alter Turm", description: "Aussichtsturm", extract: "Der Alte Turm ist ein Turm." },
      people: ["Erika"],
      description: null,
      keywords: [],
    }, true);
    expect(p.prompt).toContain("Ort: Musterstadt, Beispielland");
    expect(p.prompt).toContain("Sehenswürdigkeit im Bild: Alter Turm (Aussichtsturm)");
    expect(p.prompt).toContain("Personen im Bild: Erika");
    expect(p.prompt).not.toContain("Beschreibung aus der Datei");
    expect(p.system).toMatch(/erfindest keine Namen/);
  });

  it("keeps only captions that name a concrete fact", () => {
    const ctx = { when: "Samstag", place: "Altstadt, Musterstadt", poi: { name: "Alter Turm", description: null, extract: null }, people: ["Erika Beispiel"], description: null, keywords: ["Urlaub"] };
    expect(hasConcreteFacts(ctx)).toBe(true);
    expect(hasConcreteFacts({ ...ctx, place: null, poi: null, people: [] })).toBe(false);
    expect(captionNamesAFact("Abendlicht am Alten Turm", ctx)).toBe(true);
    expect(captionNamesAFact("Gassen in Musterstadt", ctx)).toBe(true);
    expect(captionNamesAFact("Erika auf der Treppe", ctx)).toBe(true);
    expect(captionNamesAFact("Ein alter Keller", ctx)).toBe(false);
    expect(captionNamesAFact("Urlaub am Samstag", ctx)).toBe(false);
  });

  it("reads captions and titles strictly", () => {
    expect(parseCaption({ caption: '  „Abendlicht am Alten Turm“ #urlaub ' })).toBe("Abendlicht am Alten Turm");
    expect(parseCaption({ caption: "" })).toBeNull();
    expect(parseCaption("nope")).toBeNull();
    const long = parseCaption({ caption: "Wort ".repeat(60) })!;
    expect(long.length).toBeLessThanOrEqual(MAX_CAPTION_LENGTH);
    expect(long.endsWith("…")).toBe(true);
    expect(parseChapterTitle({ title: "Am Alten Turm." })).toBe("Am Alten Turm");
    // The date is under the title already.
    expect(parseChapterTitle({ title: "Am See, 3. Juni" })).toBeNull();
    expect(parseChapterTitle({ title: "Sommer 2024" })).toBeNull();
  });

  it("cuts an article at a sentence end", () => {
    const text = `${"Ein Satz über den Turm. ".repeat(40)}`;
    const cut = articleExtract(text)!;
    expect(cut.length).toBeLessThanOrEqual(700);
    expect(cut.endsWith(".")).toBe(true);
    expect(articleExtract("")).toBeNull();
  });

  it("offers the model the rule's candidates and reads its pick", () => {
    const list = [photo(1, { score: 90 }), photo(2, { width: 2000, height: 3000 }), photo(3)];
    const ranked = rankLayouts("a4-landscape", list);
    expect(ranked.length).toBe(3);
    expect(ranked[0].cost).toBeLessThanOrEqual(ranked[1].cost);
    const p = buildLayoutPrompt("a4-landscape", list.map((x) => ({ ...x, faces: x.id === 1 ? 2 : 0, caption: null })), ranked);
    expect(p.prompt).toContain("Foto A: Querformat, Bewertung 90 von 100, 2 Gesichter");
    expect(p.prompt).toContain("Foto B: Hochformat");
    expect(p.prompt).toMatch(/^1\. /m);
    expect(parseLayoutPick({ choice: 2, reason: "Das Hochformat steht." }, 3)).toEqual({ index: 1, reason: "Das Hochformat steht." });
    expect(parseLayoutPick({ choice: "3" }, 3)?.index).toBe(2);
    expect(parseLayoutPick({ choice: 4 }, 3)).toBeNull();
  });
});

describe("photo book: the model's texts and layouts", () => {
  let user: { id: number };

  beforeEach(async () => {
    await db.delete(photoBook);
    await db.delete(photoPoiMatches);
    await db.delete(poiReferences);
    await db.delete(userFaceAssignments);
    await db.delete(persons);
    await db.delete(faces);
    await db.delete(photoCuration);
    await db.delete(photos);
    await db.delete(users);
    user = await createUserLogic({ email: "book-ai@test.com", name: "U", password: "pw" });
  });

  let seq = 0;
  async function upload(takenAt: string, values: Partial<typeof photos.$inferInsert> = {}) {
    seq += 1;
    const p = await service.uploadPhotoLogic(user.id, { data: Buffer.from([seq % 256, seq >> 8, 9]), name: `ai${seq}.jpg`, mimeType: "image/jpeg" });
    await db.update(photos).set({ taken_at: takenAt, width: 3000, height: 2000, ...values }).where(eq(photos.id, p.id));
    return p;
  }

  function fakeDeps(over: Partial<PhotoBookAiDeps> = {}) {
    const prompts: { kind: "vision" | "text"; prompt: LlmPrompt }[] = [];
    const deps: PhotoBookAiDeps = {
      isGpuLent: async () => false,
      image: async () => Buffer.from("jpeg"),
      article: async () => ({ description: "Aussichtsturm", extract: "Der Alte Turm steht seit langer Zeit." }),
      askVision: async (_img, prompt) => {
        prompts.push({ kind: "vision", prompt });
        return { result: { caption: `Blick über Musterstadt ${prompts.length}` }, model: "test-model" };
      },
      askText: async (prompt) => {
        prompts.push({ kind: "text", prompt });
        if (prompt.schema.properties && "choice" in (prompt.schema.properties as object)) return { result: { choice: 2, reason: "Ruhiger." }, model: "" };
        return { result: { title: "Rund um den Alten Turm" }, model: "" };
      },
      ...over,
    };
    return { deps, prompts };
  }

  function newJob(bookId: number): PhotoBookAiJob {
    return {
      book_id: bookId, status: "running", tasks: [], done: 0, total: 0, captions: 0, chapters: 0, layouts: 0,
      skipped: 0, error: null, started_at: new Date().toISOString(), finished_at: null,
    };
  }

  it("writes captions from the facts, keeps the user's, and titles the chapter", async () => {
    const list = [];
    for (let i = 0; i < 5; i++) list.push(await upload(`2024-06-01 1${i}:00:00`, { location_city: "Musterstadt", location_country: "Beispielland" }));
    await db.insert(poiReferences).values({ qid: "Q1", name: "Old Tower", name_de: "Alter Turm", wikipedia_url: "https://de.wikipedia.org/wiki/Alter_Turm" });
    await db.insert(photoPoiMatches).values({ photo_id: list[0].id, qid: "Q1", osm_ref: "n1", name: "Old Tower", name_de: "Alter Turm", match_score: 0.9, source: "test" });
    const [person] = await db.insert(persons).values({ user_id: user.id, name: "Erika" }).returning();
    const [face] = await db.insert(faces).values({ photo_id: list[1].id, bbox: JSON.stringify({ x: 0.4, y: 0.3, width: 0.2, height: 0.2 }), embedding: "[]" }).returning();
    await db.insert(userFaceAssignments).values({ user_id: user.id, face_id: face.id, person_id: person.id });

    const id = await createPhotoBook(user.id, { title: "Buch", photoIds: list.map((p) => p.id) });
    await setPhotoBookCaption(user.id, id, list[2].id, "Mein eigener Text");

    const { deps, prompts } = fakeDeps();
    const job = await runPhotoBookAi(user.id, id, newJob(id), { tasks: ["captions", "chapters"] }, deps);
    expect(job.status).toBe("done");
    expect(job.captions).toBe(4);
    expect(job.chapters).toBe(1);
    expect(job.done).toBe(job.total);

    const vision = prompts.filter((p) => p.kind === "vision").map((p) => p.prompt.prompt);
    expect(vision.some((p) => p.includes("Sehenswürdigkeit im Bild: Alter Turm (Aussichtsturm)") && p.includes("Der Alte Turm steht"))).toBe(true);
    expect(vision.some((p) => p.includes("Personen im Bild: Erika"))).toBe(true);
    expect(vision.every((p) => p.includes("Ort: Musterstadt, Beispielland"))).toBe(true);
    const title = prompts.find((p) => p.kind === "text")!.prompt.prompt;
    expect(title).toContain("Mein eigener Text");
    expect(title).toContain("Sehenswürdigkeiten: Alter Turm");

    let view = await getPhotoBookView(user.id, id);
    expect(view.chapters[0]).toMatchObject({ title: "Rund um den Alten Turm", title_source: "llm", title_suggestion: "Rund um den Alten Turm" });
    const slots = view.pages.flatMap((p) => p.slots);
    expect(slots.find((s) => s.photo_id === list[2].id)).toMatchObject({ caption: "Mein eigener Text", caption_source: "user" });
    expect(slots.filter((s) => s.caption_source === "llm")).toHaveLength(4);
    // Captions are off until the user turns them on.
    expect(view.pages.every((p) => !p.captions && p.slots.every((s) => s.caption_rect === null))).toBe(true);

    // A title the user wrote stays; the next proposal waits beside it.
    await updatePhotoBookChapter(user.id, id, view.chapters[0].id, { title: "Mein Kapitel" });
    const second = fakeDeps({ askText: async () => ({ result: { title: "Turm und Gassen" }, model: "" }) });
    await runPhotoBookAi(user.id, id, newJob(id), { tasks: ["captions", "chapters"], overwrite: true }, second.deps);
    view = await getPhotoBookView(user.id, id);
    expect(view.chapters[0]).toMatchObject({ title: "Mein Kapitel", title_source: "user", title_suggestion: "Turm und Gassen" });
    expect(view.pages.flatMap((p) => p.slots).find((s) => s.photo_id === list[2].id)!.caption).toBe("Mein eigener Text");
    await acceptPhotoBookChapterSuggestion(user.id, id, view.chapters[0].id);
    expect((await getPhotoBookView(user.id, id)).chapters[0].title).toBe("Turm und Gassen");
  });

  it("writes from the facts alone when the model cannot see, and stops while the GPU is lent", async () => {
    const list = [];
    for (let i = 0; i < 4; i++) list.push(await upload(`2024-06-01 1${i}:00:00`, { location_city: i < 2 ? "Musterstadt" : null }));
    const id = await createPhotoBook(user.id, { title: "Buch", photoIds: list.map((p) => p.id) });

    const { VisionUnavailableError } = await import("./photo-book-ai");
    const texts: string[] = [];
    const blind = fakeDeps({
      askVision: async () => { throw new VisionUnavailableError("no projector"); },
      askText: async (p) => { texts.push(p.prompt); return { result: { caption: "Unterwegs in Musterstadt" }, model: "" }; },
    });
    const job = await runPhotoBookAi(user.id, id, newJob(id), { tasks: ["captions"] }, blind.deps);
    // Only the two photos with a place carry a caption without the picture.
    expect(job.captions).toBe(2);
    expect(job.skipped).toBe(2);
    expect(texts.every((t) => t.includes("nicht sehen"))).toBe(true);

    const lent = fakeDeps({ isGpuLent: async () => true });
    const stopped = await runPhotoBookAi(user.id, id, newJob(id), { tasks: ["captions"] }, lent.deps);
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toMatch(/Ästhetik-Bewertung/);
  });

  it("writes a caption only when there is something concrete to say", async () => {
    const concrete = await upload("2024-06-01 10:00:00", { location_city: "Musterstadt" });
    const described = await upload("2024-06-01 11:00:00", { description: "Weinlese bei Erika" });
    const bare = await upload("2024-06-01 12:00:00", { keywords: ["Urlaub"] });
    const id = await createPhotoBook(user.id, { title: "Buch", photoIds: [concrete.id, described.id, bare.id] });

    const asked: number[] = [];
    const { deps } = fakeDeps({
      image: async (photoId) => { asked.push(photoId); return Buffer.from("jpeg"); },
      // The model describes the picture instead of naming a fact.
      askVision: async () => ({ result: { caption: "Ein alter Keller" }, model: "test-model" }),
    });
    const job = await runPhotoBookAi(user.id, id, newJob(id), { tasks: ["captions"] }, deps);
    // A photo with only a date and keywords is not even asked about.
    expect(asked).not.toContain(bare.id);
    expect(job.captions).toBe(0);
    expect(job.skipped).toBe(3);

    // An earlier caption of the model that names nothing goes with "neu schreiben".
    await db.insert(photoBookCaption).values({ book_id: id, photo_id: bare.id, text: "Ein alter Keller", source: "llm", model: "old" });
    const named = fakeDeps({ askVision: async () => ({ result: { caption: "Weinlese mit Erika" }, model: "test-model" }) });
    const again = await runPhotoBookAi(user.id, id, newJob(id), { tasks: ["captions"], overwrite: true }, named.deps);
    expect(again.captions).toBe(1);
    const slots = (await getPhotoBookView(user.id, id)).pages.flatMap((p) => p.slots);
    expect(slots.find((s) => s.photo_id === described.id)!.caption).toBe("Weinlese mit Erika");
    expect(slots.find((s) => s.photo_id === bare.id)!.caption).toBeNull();
    expect(slots.find((s) => s.photo_id === concrete.id)!.caption).toBeNull();
  });

  it("lets the model pick among the rule's layouts, within the crop guard, and measures the picks", async () => {
    const list = [];
    for (let i = 0; i < 9; i++) list.push(await upload(`2024-06-01 1${i}:00:00`, { ai_quality_score: 0.5 }));
    const id = await createPhotoBook(user.id, { title: "Buch", photoIds: list.map((p) => p.id) });
    const before = await getPhotoBookView(user.id, id);
    const multi = before.pages.filter((p) => p.kind === "photos" && p.slots.length >= 2);
    expect(multi.length).toBeGreaterThan(0);

    const { deps } = fakeDeps();
    const job = await runPhotoBookAi(user.id, id, newJob(id), { tasks: ["layouts"] }, deps);
    expect(job.status).toBe("done");
    const after = await getPhotoBookView(user.id, id);
    const picked = after.pages.filter((p) => p.layout_source === "llm");
    expect(picked.length + job.skipped).toBe(multi.length);
    for (const p of picked) {
      expect(p.layout_reason).toBe("Ruhiger.");
      expect(p.layout_options.some((o) => o.id === p.layout)).toBe(true);
    }

    let stats = await layoutPickStats(user.id);
    expect(stats.llm.pages).toBe(picked.length);
    expect(stats.llm.changed).toBe(0);
    if (picked.length) {
      const page = picked[0];
      const other = page.layout_options.find((o) => o.id !== page.layout)!;
      await setPhotoBookPageLayout(user.id, id, page.id, other.id);
      stats = await layoutPickStats(user.id);
      expect(stats.llm.changed).toBe(1);
      // The user's layout is not the model's to change again.
      await runPhotoBookAi(user.id, id, newJob(id), { tasks: ["layouts"] }, deps);
      const row = (await db.select().from(photoBookPage).where(eq(photoBookPage.id, page.id)))[0];
      expect(row.layout).toBe(other.id);
      expect(row.layout_source).toBe("user");
    }
  });

  it("turns down a pick that crops far more than the rule's", async () => {
    // Two landscapes side by side crop a lot; stacked they fit. A model that
    // asks for the worst candidate is refused.
    const list = [];
    for (let i = 0; i < 4; i++) list.push(await upload(`2024-06-01 1${i}:00:00`, { width: 4000, height: 1000 }));
    const id = await createPhotoBook(user.id, { title: "Buch", photoIds: list.map((p) => p.id), format: "a4-portrait" });
    const loaded = await loadPhotoBook(user.id, id);
    const pages = loaded.pages.filter((p) => p.kind === "photos" && p.photos.length >= 2);
    const { deps } = fakeDeps({ askText: async (p) => ({ result: { choice: (p.prompt.match(/^\d\./gm) ?? []).length, reason: "x" }, model: "" }) });
    const job = await runPhotoBookAi(user.id, id, newJob(id), { tasks: ["layouts"] }, deps);
    const view = await getPhotoBookView(user.id, id);
    const llm = view.pages.filter((p) => p.layout_source === "llm").length;
    expect(llm + job.skipped).toBe(pages.length);
    expect(job.skipped).toBeGreaterThan(0);
  });

  it("shows captions per page and puts them into the PDF", async () => {
    const list = [];
    for (let i = 0; i < 9; i++) list.push(await upload(`2024-06-01 1${i}:00:00`));
    const id = await createPhotoBook(user.id, { title: "Buch", photoIds: list.map((p) => p.id) });
    for (const p of list) await setPhotoBookCaption(user.id, id, p.id, `Text ${p.id}`);
    await updatePhotoBook(user.id, id, { settings: { captions: true } });
    let view = await getPhotoBookView(user.id, id);
    expect(view.settings.captions).toBe(true);
    expect(view.pages.every((p) => p.captions)).toBe(true);
    const page = view.pages[1];
    expect(page.slots[0].caption_rect).not.toBeNull();

    await setPhotoBookPageCaptions(user.id, id, page.id, false);
    view = await getPhotoBookView(user.id, id);
    expect(view.pages[1]).toMatchObject({ captions: false, captions_override: false });
    expect(view.pages[1].slots[0].caption_rect).toBeNull();

    await setPhotoBookCaption(user.id, id, list[0].id, "  ");
    view = await getPhotoBookView(user.id, id);
    expect(view.pages.flatMap((p) => p.slots).find((s) => s.photo_id === list[0].id)!.caption).toBeNull();
    await expect(setPhotoBookCaption(user.id, id, 999999, "x")).rejects.toThrow(/not in this book/);

    const book = toRenderBook(await loadPhotoBook(user.id, id));
    expect(book.pages[1].captioned).toBe(false);
    expect(book.pages.some((p, i) => i !== 1 && p.captioned)).toBe(true);
    expect(book.pages.flatMap((p) => p.slots).find((s) => s.photoId === list[1].id)!.caption).toBe(`Text ${list[1].id}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-book-ai-"));
    const img = path.join(dir, "a.jpg");
    await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 90, g: 120, b: 200 } } }).jpeg().toFile(img);
    const out = path.join(dir, "book.pdf");
    await renderHomePdf(book, async () => img, out);
    const pdf = fs.readFileSync(out, "latin1");
    expect(pdf.startsWith("%PDF")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
