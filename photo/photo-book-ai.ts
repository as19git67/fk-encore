/**
 * The local model's work on a photo book (documentation/plans/fotobuch.md,
 * stages 2 and 3): captions for the photos, titles for the chapters and the
 * layout of each photo page. One job per book, started by the user, run in
 * the background through the `llm` queue at background priority, so the
 * assistant and anyone waiting at a button go first.
 *
 * What the model writes never replaces what the user wrote: a caption the
 * user typed stays, a chapter title the user edited stays (the proposal is
 * kept next to it), a layout the user picked stays. A layout the model picks
 * is only taken when it crops at most `LAYOUT_MAX_EXTRA_COST` more than the
 * rule's own; each page remembers who picked it, so the editor can show how
 * often the model's picks are kept against the rule's (`layoutPickStats`).
 */

import fs from "fs";
import path from "path";
import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec } from "../db/adapter";
import {
  faces,
  persons,
  photoBook,
  photoBookCaption,
  photoBookChapter,
  photoBookPage,
  photoBookSlot,
  photoPoiMatches,
  photos,
  poiReferences,
  userFaceAssignments,
} from "../db/schema";
import { AI_PRIORITY, AiSlotTimeoutError, withAiSlot } from "../ai-queue/slot-helper";
import { isGpuLent, llmBudgetMs } from "../lib/llm-lease";
import { getWikipediaClient, parseArticleUrl } from "../trip-planner/wikipedia-client";
import { convertHeicToJpeg } from "./heic-convert.service";
import { resizeImageInPool } from "./image-pool";
import { getPhotoDiskPath } from "./photo.service";
import { loadPhotoBook, type LoadedBook, type LoadedPage } from "./photo-book.service";
import {
  RECOGNISABLE_FACE_MIN_AREA,
  RECOGNISABLE_FACE_MIN_SHARPNESS,
  formatDay,
  photoScore,
  rankLayouts,
  type BookPhoto,
} from "./photo-book-layout";
import {
  LAYOUT_CANDIDATES,
  LAYOUT_MAX_EXTRA_COST,
  articleExtract,
  buildCaptionPrompt,
  buildChapterTitlePrompt,
  buildLayoutPrompt,
  parseCaption,
  parseChapterTitle,
  parseLayoutPick,
  type CaptionContext,
  type LlmPrompt,
  type PoiFacts,
} from "./photo-book-prompts";

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
/** Long edge the model sees for a caption: enough to recognise a place, cheap to prefill. */
const IMAGE_WIDTH = 768;
/** Background work waits its turn for a long time, but not forever. */
const SLOT_TIMEOUT_MS = 15 * 60_000;
const CALL_TIMEOUT_MS = 180_000;
/** A POI match must be at least this sure before it names the photo's subject. */
const POI_MIN_SCORE = 0.5;
/** Captions per chapter the title prompt reads. */
const CHAPTER_CAPTIONS = 12;

export type PhotoBookAiTask = "captions" | "chapters" | "layouts";
export const PHOTO_BOOK_AI_TASKS: PhotoBookAiTask[] = ["captions", "chapters", "layouts"];

export interface PhotoBookAiOptions {
  tasks: PhotoBookAiTask[];
  /** Write captions again that the model wrote before (the user's stay). */
  overwrite?: boolean;
}

export interface PhotoBookAiJob {
  book_id: number;
  status: "running" | "done" | "failed";
  tasks: PhotoBookAiTask[];
  done: number;
  total: number;
  captions: number;
  chapters: number;
  layouts: number;
  /** Items the model gave no usable answer for. */
  skipped: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** The model cannot work now; the whole job stops with this message. */
export class PhotoBookAiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoBookAiUnavailableError";
  }
}

/** The model cannot look at pictures; captions are written from the facts alone. */
export class VisionUnavailableError extends Error {}

export interface PhotoBookAiDeps {
  isGpuLent(): Promise<boolean>;
  /** The photo as a JPEG the model can look at, or null. */
  image(photoId: number): Promise<Buffer | null>;
  /** Wikidata's description and the start of the article behind `url`, or null. */
  article(url: string): Promise<{ description: string | null; extract: string | null } | null>;
  askVision(image: Buffer, prompt: LlmPrompt): Promise<{ result: unknown; model: string }>;
  askText(prompt: LlmPrompt): Promise<{ result: unknown; model: string }>;
}

// ── facts from the database ─────────────────────────────────────────────

interface PhotoFacts {
  id: number;
  taken_at: string | null;
  location_name: string | null;
  location_short: string | null;
  location_city: string | null;
  location_country: string | null;
  description: string | null;
  keywords: string[] | null;
}

function place(p: PhotoFacts): string | null {
  if (p.location_short) return p.location_short;
  const parts = [p.location_name, p.location_city, p.location_country].filter((x): x is string => !!x && !!x.trim());
  return parts.length ? [...new Set(parts)].join(", ") : null;
}

function when(takenAt: string | null): string | null {
  if (!takenAt) return null;
  const day = formatDay(takenAt.slice(0, 10));
  const time = takenAt.slice(11, 16);
  return time && time !== "00:00" ? `${day}, ${time} Uhr` : day;
}

/** The named people on each photo, as the owner named them. */
async function peopleByPhoto(userId: number, photoIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!photoIds.length) return out;
  const rows = await dbAll<{ photo_id: number; name: string }>(
    db.selectDistinct({ photo_id: faces.photo_id, name: persons.name })
      .from(faces)
      .innerJoin(userFaceAssignments, and(eq(userFaceAssignments.face_id, faces.id), eq(userFaceAssignments.user_id, userId)))
      .innerJoin(persons, and(eq(persons.id, userFaceAssignments.person_id), eq(persons.user_id, userId)))
      .where(and(inArray(faces.photo_id, photoIds), eq(userFaceAssignments.ignored, false), sql`${persons.name} <> 'Unbenannt'`)),
  );
  for (const r of rows) {
    const list = out.get(r.photo_id) ?? [];
    if (!list.includes(r.name)) list.push(r.name);
    out.set(r.photo_id, list);
  }
  return out;
}

/** The surest landmark match of each photo. */
async function poiByPhoto(photoIds: number[]): Promise<Map<number, { name: string; url: string | null }>> {
  const out = new Map<number, { name: string; url: string | null }>();
  if (!photoIds.length) return out;
  const rows = await dbAll<{ photo_id: number; name: string; name_de: string | null; url: string | null; score: number }>(
    db.select({
      photo_id: photoPoiMatches.photo_id,
      name: photoPoiMatches.name,
      name_de: photoPoiMatches.name_de,
      url: poiReferences.wikipedia_url,
      score: photoPoiMatches.match_score,
    })
      .from(photoPoiMatches)
      .leftJoin(poiReferences, eq(poiReferences.qid, photoPoiMatches.qid))
      .where(and(inArray(photoPoiMatches.photo_id, photoIds), eq(photoPoiMatches.ambiguous, false), sql`${photoPoiMatches.match_score} >= ${POI_MIN_SCORE}`))
      .orderBy(sql`${photoPoiMatches.match_score} DESC`),
  );
  for (const r of rows) if (!out.has(r.photo_id)) out.set(r.photo_id, { name: r.name_de || r.name, url: r.url });
  return out;
}

async function recognisableFaceCounts(photoIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!photoIds.length) return out;
  const rows = await dbAll<{ photo_id: number; n: number }>(
    db.select({ photo_id: faces.photo_id, n: sql<number>`COUNT(*)::int` })
      .from(faces)
      .where(and(
        inArray(faces.photo_id, photoIds),
        sql`COALESCE((${faces.bbox}::jsonb->>'width')::float8, 0) * COALESCE((${faces.bbox}::jsonb->>'height')::float8, 0) >= ${RECOGNISABLE_FACE_MIN_AREA}`,
        sql`(${faces.sharpness} IS NULL OR ${faces.sharpness} >= ${RECOGNISABLE_FACE_MIN_SHARPNESS})`,
      ))
      .groupBy(faces.photo_id),
  );
  for (const r of rows) out.set(r.photo_id, Number(r.n));
  return out;
}

// ── the job ─────────────────────────────────────────────────────────────

const jobs = new Map<string, PhotoBookAiJob>();
const jobKey = (userId: number, bookId: number) => `${userId}:${bookId}`;

export function getPhotoBookAiJob(userId: number, bookId: number): PhotoBookAiJob | null {
  return jobs.get(jobKey(userId, bookId)) ?? null;
}

function bookPhotoIds(loaded: LoadedBook): number[] {
  const ids: number[] = [];
  for (const p of loaded.pages) for (const s of p.photos) if (!ids.includes(s.photo_id)) ids.push(s.photo_id);
  return ids;
}

async function saveCaption(bookId: number, photoId: number, text: string, model: string): Promise<void> {
  const values = { book_id: bookId, photo_id: photoId, text, source: "llm" as const, model, created_at: new Date().toISOString() };
  // Never over a caption the user wrote in the meantime.
  await db.insert(photoBookCaption).values(values).onConflictDoUpdate({
    target: [photoBookCaption.book_id, photoBookCaption.photo_id],
    set: values,
    setWhere: sql`${photoBookCaption.source} = 'llm'`,
  });
}

async function writeCaptions(
  userId: number,
  loaded: LoadedBook,
  job: PhotoBookAiJob,
  deps: PhotoBookAiDeps,
  overwrite: boolean,
): Promise<void> {
  const ids = bookPhotoIds(loaded).filter((id) => {
    const c = loaded.captions.get(id);
    return !c || (c.source === "llm" && overwrite);
  });
  const facts = ids.length
    ? await dbAll<PhotoFacts>(
        db.select({
          id: photos.id,
          taken_at: photos.taken_at,
          location_name: photos.location_name,
          location_short: photos.location_short,
          location_city: photos.location_city,
          location_country: photos.location_country,
          description: photos.description,
          keywords: photos.keywords,
        }).from(photos).where(inArray(photos.id, ids)),
      )
    : [];
  const byId = new Map(facts.map((f) => [f.id, f]));
  const people = await peopleByPhoto(userId, ids);
  const pois = await poiByPhoto(ids);
  const articles = new Map<string, Promise<{ description: string | null; extract: string | null } | null>>();
  let vision = true;

  for (const id of ids) {
    const f = byId.get(id);
    if (!f) {
      job.done += 1;
      continue;
    }
    const match = pois.get(id);
    let poi: PoiFacts | null = null;
    if (match) {
      let article: { description: string | null; extract: string | null } | null = null;
      if (match.url) {
        if (!articles.has(match.url)) articles.set(match.url, deps.article(match.url).catch(() => null));
        article = await articles.get(match.url)!;
      }
      poi = { name: match.name, description: article?.description ?? null, extract: articleExtract(article?.extract) };
    }
    const ctx: CaptionContext = {
      when: when(f.taken_at),
      place: place(f),
      poi,
      people: people.get(id) ?? [],
      description: f.description?.trim() || null,
      keywords: (f.keywords ?? []).slice(0, 8),
    };
    let answer: { result: unknown; model: string } | null = null;
    const image = vision ? await deps.image(id) : null;
    if (image) {
      try {
        answer = await deps.askVision(image, buildCaptionPrompt(ctx, true));
      } catch (err) {
        if (!(err instanceof VisionUnavailableError)) throw err;
        vision = false;
      }
    }
    // Without the picture the facts alone must carry the caption.
    if (!answer && (ctx.place || ctx.poi || ctx.people.length || ctx.description)) {
      answer = await deps.askText(buildCaptionPrompt(ctx, false));
    }
    const text = answer ? parseCaption(answer.result) : null;
    if (text && answer) {
      await saveCaption(loaded.book.id, id, text, answer.model);
      loaded.captions.set(id, { text, source: "llm" });
      job.captions += 1;
    } else {
      job.skipped += 1;
    }
    job.done += 1;
  }
}

function countBy(values: string[]): string[] {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

async function writeChapterTitles(userId: number, loaded: LoadedBook, job: PhotoBookAiJob, deps: PhotoBookAiDeps): Promise<void> {
  const ids = bookPhotoIds(loaded);
  const people = await peopleByPhoto(userId, ids);
  const pois = await poiByPhoto(ids);
  const facts = ids.length
    ? await dbAll<PhotoFacts>(
        db.select({
          id: photos.id,
          taken_at: photos.taken_at,
          location_name: photos.location_name,
          location_short: photos.location_short,
          location_city: photos.location_city,
          location_country: photos.location_country,
          description: photos.description,
          keywords: photos.keywords,
        }).from(photos).where(inArray(photos.id, ids)),
      )
    : [];
  const byId = new Map(facts.map((f) => [f.id, f]));

  for (const ch of loaded.chapters) {
    const chIds: number[] = [];
    for (const p of loaded.pages) if (p.chapter_id === ch.id) for (const s of p.photos) if (!chIds.includes(s.photo_id)) chIds.push(s.photo_id);
    if (!chIds.length) {
      job.done += 1;
      continue;
    }
    const prompt = buildChapterTitlePrompt({
      ruleTitle: ch.title,
      dates: ch.subtitle,
      places: countBy(chIds.map((id) => byId.get(id)?.location_city ?? "").filter(Boolean)).slice(0, 5),
      pois: countBy(chIds.map((id) => pois.get(id)?.name ?? "").filter(Boolean)).slice(0, 6),
      people: countBy(chIds.flatMap((id) => people.get(id) ?? [])).slice(0, 6),
      captions: chIds.map((id) => loaded.captions.get(id)?.text).filter((t): t is string => !!t).slice(0, CHAPTER_CAPTIONS),
    });
    const answer = await deps.askText(prompt);
    const title = parseChapterTitle(answer.result);
    if (title) {
      // A title the user wrote stays; the proposal is kept beside it.
      await dbExec(db.update(photoBookChapter).set({
        title_suggestion: title,
        ...(ch.title_source === "user" ? {} : { title, title_source: "llm" as const }),
      }).where(eq(photoBookChapter.id, ch.id)));
      job.chapters += 1;
    } else {
      job.skipped += 1;
    }
    job.done += 1;
  }
}

function toBookPhoto(s: LoadedPage["photos"][number]): BookPhoto {
  return { id: s.photo_id, takenAt: s.taken_at, width: s.width, height: s.height, score: photoScore(s.aesthetic, s.quality), city: s.city };
}

async function pickLayouts(loaded: LoadedBook, job: PhotoBookAiJob, deps: PhotoBookAiDeps): Promise<void> {
  const ids = bookPhotoIds(loaded);
  const faceCounts = await recognisableFaceCounts(ids);
  let previous: string | null = null;
  for (const page of loaded.pages) {
    const isCandidate = page.kind === "photos" && page.photos.length >= 2 && page.layout_source !== "user";
    if (!isCandidate) {
      previous = page.layout.id;
      job.done += 1;
      continue;
    }
    const list = page.photos.map(toBookPhoto);
    // The chronological order is the rule's starting point, whatever order the page has now.
    list.sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? "") || a.id - b.id);
    const ranked = rankLayouts(loaded.format, list, previous);
    const candidates = ranked.slice(0, LAYOUT_CANDIDATES);
    if (candidates.length < 2) {
      previous = page.layout.id;
      job.done += 1;
      continue;
    }
    const prompt = buildLayoutPrompt(
      loaded.format,
      list.map((p) => ({
        id: p.id,
        width: p.width,
        height: p.height,
        score: p.score,
        faces: faceCounts.get(p.id) ?? 0,
        caption: loaded.captions.get(p.id)?.text ?? null,
      })),
      candidates,
    );
    const answer = await deps.askText(prompt);
    const pick = parseLayoutPick(answer.result, candidates.length);
    const chosen = pick ? candidates[pick.index] : null;
    if (!pick || !chosen || chosen.cost > candidates[0].cost + LAYOUT_MAX_EXTRA_COST) {
      job.skipped += 1;
      previous = page.layout.id;
      job.done += 1;
      continue;
    }
    await dbExec(db.delete(photoBookSlot).where(eq(photoBookSlot.page_id, page.id)));
    await dbExec(db.insert(photoBookSlot).values(chosen.photos.map((p, slot) => ({ page_id: page.id, slot, photo_id: p.id }))));
    await dbExec(db.update(photoBookPage).set({
      layout: chosen.layout.id,
      layout_source: "llm",
      layout_origin: "llm",
      rule_layout: candidates[0].layout.id,
      layout_reason: pick.reason,
    }).where(eq(photoBookPage.id, page.id)));
    job.layouts += 1;
    previous = chosen.layout.id;
    job.done += 1;
  }
}

/** Runs the job to its end; the endpoint starts it without waiting. */
export async function runPhotoBookAi(
  userId: number,
  bookId: number,
  job: PhotoBookAiJob,
  options: PhotoBookAiOptions,
  deps: PhotoBookAiDeps,
): Promise<PhotoBookAiJob> {
  try {
    if (await deps.isGpuLent()) {
      throw new PhotoBookAiUnavailableError("Während der nächtlichen Ästhetik-Bewertung arbeitet die KI nicht an Fotobüchern. Bitte später noch einmal starten.");
    }
    let loaded = await loadPhotoBook(userId, bookId);
    const tasks = PHOTO_BOOK_AI_TASKS.filter((t) => options.tasks.includes(t));
    job.total =
      (tasks.includes("captions") ? bookPhotoIds(loaded).length : 0) +
      (tasks.includes("chapters") ? loaded.chapters.length : 0) +
      (tasks.includes("layouts") ? loaded.pages.length : 0);
    // Captions first: the chapter titles and the layout read them.
    if (tasks.includes("captions")) {
      const before = job.done;
      await writeCaptions(userId, loaded, job, deps, !!options.overwrite);
      job.done = before + bookPhotoIds(loaded).length;
    }
    if (tasks.includes("chapters")) await writeChapterTitles(userId, loaded, job, deps);
    if (tasks.includes("layouts")) {
      loaded = await loadPhotoBook(userId, bookId);
      await pickLayouts(loaded, job, deps);
    }
    await dbExec(db.update(photoBook).set({ updated_at: sql`now()` }).where(eq(photoBook.id, bookId)));
    job.status = "done";
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof PhotoBookAiUnavailableError ? err.message : `Die KI-Vorschläge sind abgebrochen: ${(err as Error).message}`;
    if (!(err instanceof PhotoBookAiUnavailableError)) console.warn(`[photo-book-ai] book ${bookId}:`, err);
  } finally {
    job.finished_at = new Date().toISOString();
  }
  return job;
}

/** Start the job for a book; a job already running for it is returned as it is. */
export async function startPhotoBookAi(
  userId: number,
  bookId: number,
  options: PhotoBookAiOptions,
  deps: PhotoBookAiDeps = realPhotoBookAiDeps,
): Promise<PhotoBookAiJob> {
  const key = jobKey(userId, bookId);
  const running = jobs.get(key);
  if (running?.status === "running") return running;
  await loadPhotoBook(userId, bookId); // owner check before anything starts
  const job: PhotoBookAiJob = {
    book_id: bookId,
    status: "running",
    tasks: PHOTO_BOOK_AI_TASKS.filter((t) => options.tasks.includes(t)),
    done: 0,
    total: 0,
    captions: 0,
    chapters: 0,
    layouts: 0,
    skipped: 0,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  jobs.set(key, job);
  void runPhotoBookAi(userId, bookId, job, options, deps);
  return job;
}

// ── measuring the layout picks ──────────────────────────────────────────

export interface LayoutPickStats {
  /** Pages whose layout the rule picked, and how many of them the user changed. */
  rule: { pages: number; changed: number };
  llm: { pages: number; changed: number };
  /** Pages where the model chose differently from the rule. */
  llm_differs: number;
}

/**
 * How often the user changed a layout, by who picked it, over all books of
 * `userId`. The model's picks are worth adopting when they are changed no
 * more often than the rule's.
 */
export async function layoutPickStats(userId: number): Promise<LayoutPickStats> {
  const rows = await dbAll<{ origin: string; changed: number; pages: number; differs: number }>(
    db.select({
      origin: photoBookPage.layout_origin,
      pages: sql<number>`COUNT(*)::int`,
      changed: sql<number>`COUNT(*) FILTER (WHERE ${photoBookPage.layout_source} = 'user')::int`,
      differs: sql<number>`COUNT(*) FILTER (WHERE ${photoBookPage.rule_layout} IS NOT NULL AND ${photoBookPage.rule_layout} <> ${photoBookPage.layout} AND ${photoBookPage.layout_source} = 'llm')::int`,
    })
      .from(photoBookPage)
      .innerJoin(photoBook, eq(photoBook.id, photoBookPage.book_id))
      .where(and(eq(photoBook.user_id, userId), eq(photoBookPage.kind, "photos"), sql`(SELECT COUNT(*) FROM ${photoBookSlot} s WHERE s.page_id = ${photoBookPage.id}) >= 2`))
      .groupBy(photoBookPage.layout_origin),
  );
  const out: LayoutPickStats = { rule: { pages: 0, changed: 0 }, llm: { pages: 0, changed: 0 }, llm_differs: 0 };
  for (const r of rows) {
    const bucket = r.origin === "llm" ? out.llm : out.rule;
    bucket.pages += Number(r.pages);
    bucket.changed += Number(r.changed);
    out.llm_differs += Number(r.differs);
  }
  return out;
}

// ── the real dependencies ───────────────────────────────────────────────

async function photoImage(photoId: number): Promise<Buffer | null> {
  const rows = await dbAll<{ filename: string; external_path: string | null }>(
    db.select({ filename: photos.filename, external_path: photos.external_path }).from(photos).where(eq(photos.id, photoId)),
  );
  const photo = rows[0];
  if (!photo) return null;
  const filePath = getPhotoDiskPath(photo);
  if (!fs.existsSync(filePath)) return null;
  try {
    const ext = path.extname(photo.filename).toLowerCase();
    const bytes = ext === ".heic" || ext === ".heif" ? await convertHeicToJpeg(filePath) : await fs.promises.readFile(filePath);
    return await resizeImageInPool(bytes, IMAGE_WIDTH);
  } catch {
    return null;
  }
}

async function readArticle(url: string): Promise<{ description: string | null; extract: string | null } | null> {
  const ref = parseArticleUrl(url);
  if (!ref) return null;
  const client = getWikipediaClient();
  const de = ref.lang === "de" ? ref.title : await client.germanTitle(ref).catch(() => null);
  const article = await client.article(de ? { lang: "de", title: de } : ref);
  if (!article) return null;
  const lead = article.sections.find((s) => s.heading == null)?.text ?? article.sections[0]?.text ?? null;
  return { description: article.description, extract: lead };
}

async function post(pathName: string, body: Record<string, unknown>, label: string): Promise<Response> {
  const call = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), await llmBudgetMs(CALL_TIMEOUT_MS));
    try {
      return await fetch(`${LLM_SERVICE_URL}${pathName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await withAiSlot("llm", AI_PRIORITY.background, label, call, SLOT_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof AiSlotTimeoutError) {
      throw new PhotoBookAiUnavailableError("Die KI war zu lange mit anderen Aufgaben beschäftigt. Bitte später noch einmal starten.");
    }
    throw new PhotoBookAiUnavailableError(`Die KI ist nicht erreichbar: ${(err as Error).message}`);
  }
}

async function askVision(image: Buffer, prompt: LlmPrompt): Promise<{ result: unknown; model: string }> {
  const res = await post("/vision/json-prompt", {
    image_b64: image.toString("base64"),
    image_mime: "image/jpeg",
    system: prompt.system,
    prompt: prompt.prompt,
    schema: prompt.schema,
    max_tokens: 200,
    temperature: 0.4,
  }, "photo-book:caption");
  if (res.status === 503) {
    const detail = await res.text().catch(() => "");
    if (detail.includes("projector")) throw new VisionUnavailableError("no multimodal projector");
    throw new PhotoBookAiUnavailableError("Die KI ist gerade nicht bereit. Bitte später noch einmal starten.");
  }
  // One bad answer (invalid JSON) skips the photo, it does not end the job.
  if (res.status === 502) return { result: null, model: "" };
  if (!res.ok) throw new PhotoBookAiUnavailableError(`Die KI hat mit Fehler ${res.status} geantwortet.`);
  const body = (await res.json()) as { result: unknown; model: string };
  return { result: body.result, model: body.model };
}

async function askText(prompt: LlmPrompt): Promise<{ result: unknown; model: string }> {
  const res = await post("/json-prompt", {
    system: prompt.system,
    prompt: prompt.prompt,
    max_tokens: 200,
    temperature: 0.4,
  }, "photo-book:text");
  if (res.status === 502) return { result: null, model: "" };
  if (!res.ok) throw new PhotoBookAiUnavailableError(`Die KI hat mit Fehler ${res.status} geantwortet.`);
  // /json-prompt answers with the object itself.
  return { result: await res.json(), model: "llm-service" };
}

export const realPhotoBookAiDeps: PhotoBookAiDeps = {
  isGpuLent,
  image: photoImage,
  article: readArticle,
  askVision,
  askText,
};
