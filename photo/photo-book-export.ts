/**
 * Rendering a photo book as PDF in the background (documentation/plans/fotobuch.md).
 *
 * One job per user and book, in memory like the recap export: a book of a few
 * hundred photos takes minutes, so the endpoint starts the job and the editor
 * polls. The files go to `PHOTO_BOOK_EXPORT_DIR` under a random token, so a
 * download link cannot be guessed; a new export of the same book replaces the
 * previous files.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { convertHeicToJpeg } from "./heic-convert.service";
import { resolvePhotoFilePath } from "./photo";
import { renderUserAndCache } from "./photo-transforms-render.service";
import { bookSettings, loadPhotoBook, pageCaptioned, type LoadedBook } from "./photo-book.service";
import { repeatedCaptions } from "./photo-book-layout";
import {
  renderCoverPdf,
  renderHomePdf,
  renderInsidePdf,
  type ImageLoader,
  type RenderBook,
} from "./photo-book-pdf";

export const PHOTO_BOOK_EXPORT_DIR = path.resolve(
  process.env.PHOTO_BOOK_EXPORT_DIR || "/mnt/data/photo-book-exports",
);

// A plain union: Encore's schema parser reads the endpoint types literally.
export type PhotoBookExportMode = "print" | "home";
export type PhotoBookFileKind = "cover" | "inside" | "book";

export interface PhotoBookExportFile {
  kind: PhotoBookFileKind;
  name: string;
}

export interface PhotoBookExportJob {
  status: "running" | "done" | "failed";
  mode: PhotoBookExportMode;
  progress: number;
  error?: string;
  files: PhotoBookExportFile[];
  started_at: string;
}

const jobs = new Map<string, PhotoBookExportJob>();
const jobKey = (userId: number, bookId: number) => `${userId}:${bookId}`;

export const EXPORT_FILE_NAME = /^[0-9a-f]{32}-(cover|inside|book)\.pdf$/;

export function getPhotoBookExportJob(userId: number, bookId: number): PhotoBookExportJob | null {
  return jobs.get(jobKey(userId, bookId)) ?? null;
}

export async function resolvePhotoBookExportFile(name: string): Promise<string | null> {
  if (!EXPORT_FILE_NAME.test(name)) return null;
  const file = path.join(PHOTO_BOOK_EXPORT_DIR, name);
  try {
    await fs.promises.access(file, fs.constants.R_OK);
    return file;
  } catch {
    return null;
  }
}

/** The book as the PDF needs it: layouts, chapter titles on openers, photo ids and focal points. */
export function toRenderBook(loaded: LoadedBook): RenderBook {
  const settings = bookSettings(loaded.book.settings);
  const chapters = new Map(loaded.chapters.map((c) => [c.id, c]));
  return {
    format: loaded.format,
    title: loaded.book.title,
    subtitle: loaded.book.subtitle,
    cover: loaded.cover ? { photoId: loaded.cover.photo_id, focal: loaded.cover.auto_crop } : null,
    pages: loaded.pages.map((p) => {
      const ch = p.chapter_id != null ? chapters.get(p.chapter_id) : undefined;
      const texts = p.photos.map((s) => loaded.captions.get(s.photo_id)?.text ?? null);
      const repeats = repeatedCaptions(texts);
      return {
        layout: p.layout,
        chapterTitle: p.kind === "opener" ? ch?.title ?? null : null,
        chapterSubtitle: p.kind === "opener" ? ch?.subtitle ?? null : null,
        captioned: pageCaptioned(loaded, p),
        // A caption that repeats one above it on the page is printed once.
        slots: p.photos.map((s, i) => ({ photoId: s.photo_id, focal: s.auto_crop, caption: repeats[i] ? null : texts[i] })),
      };
    }),
    bleedMm: settings.bleed_mm,
    cropMarks: settings.crop_marks,
    spreads: settings.spreads,
    paperMm: settings.paper_mm,
  };
}

/** The owner's own edit of the photo when there is one, else the file itself. */
function imageLoader(userId: number, loaded: LoadedBook): ImageLoader {
  const filenames = new Map<number, string>();
  for (const p of loaded.pages) for (const s of p.photos) filenames.set(s.photo_id, s.filename);
  if (loaded.cover) filenames.set(loaded.cover.photo_id, loaded.cover.filename);
  return async (photoId) => {
    const filename = filenames.get(photoId);
    if (!filename) return null;
    try {
      const edited = await renderUserAndCache(photoId, userId, null);
      if (edited) return edited.buffer;
    } catch (err) {
      console.warn(`[photo-book-export] edit of photo ${photoId} not rendered:`, (err as Error).message);
    }
    const file = await resolvePhotoFilePath(filename);
    if (!file) return null;
    const ext = path.extname(file).toLowerCase();
    return ext === ".heic" || ext === ".heif" ? convertHeicToJpeg(file) : file;
  };
}

async function removeFiles(files: PhotoBookExportFile[]): Promise<void> {
  for (const f of files) await fs.promises.rm(path.join(PHOTO_BOOK_EXPORT_DIR, f.name), { force: true }).catch(() => {});
}

/**
 * Start rendering `bookId` for `userId`; while a job of the book runs, that
 * job is returned instead. The book is read once, at the start: edits made
 * while it renders go into the next export.
 */
export async function startPhotoBookExport(userId: number, bookId: number, mode: PhotoBookExportMode): Promise<PhotoBookExportJob> {
  const key = jobKey(userId, bookId);
  const running = jobs.get(key);
  if (running?.status === "running") return running;

  const loaded = await loadPhotoBook(userId, bookId);
  const book = toRenderBook(loaded);
  const load = imageLoader(userId, loaded);
  await fs.promises.mkdir(PHOTO_BOOK_EXPORT_DIR, { recursive: true });

  const token = crypto.randomBytes(16).toString("hex");
  const files: PhotoBookExportFile[] = mode === "print"
    ? [{ kind: "cover", name: `${token}-cover.pdf` }, { kind: "inside", name: `${token}-inside.pdf` }]
    : [{ kind: "book", name: `${token}-book.pdf` }];
  const job: PhotoBookExportJob = { status: "running", mode, progress: 0, files: [], started_at: new Date().toISOString() };
  const previous = running?.files ?? [];
  jobs.set(key, job);

  const out = (kind: PhotoBookFileKind) => path.join(PHOTO_BOOK_EXPORT_DIR, files.find((f) => f.kind === kind)!.name);
  void (async () => {
    try {
      if (mode === "print") {
        const coverShare = book.cover ? 1 / (book.pages.length + 1) : 0;
        await renderCoverPdf(book, load, out("cover"), () => { job.progress = coverShare; });
        await renderInsidePdf(book, load, out("inside"), (done, total) => {
          job.progress = coverShare + (1 - coverShare) * (done / Math.max(1, total));
        });
      } else {
        await renderHomePdf(book, load, out("book"), (done, total) => { job.progress = done / Math.max(1, total); });
      }
      job.files = files;
      job.progress = 1;
      job.status = "done";
      await removeFiles(previous);
    } catch (err) {
      console.error(`[photo-book-export] book ${bookId} failed:`, err);
      job.status = "failed";
      job.error = (err as Error).message;
      await removeFiles(files);
    }
  })();
  return job;
}
