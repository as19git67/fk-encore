/**
 * Photo books — endpoints (documentation/plans/fotobuch.md, issue #1729).
 *
 * GET    /photo-books                          the caller's books
 * POST   /photo-books                          build one from photos, an album, a collection or the basket
 * GET    /photo-books/:id                      the book for the editor
 * PATCH  /photo-books/:id                      title, format, cover, print settings
 * POST   /photo-books/:id/rebuild              lay it out again from its source
 * DELETE /photo-books/:id
 * PATCH  /photo-books/:id/chapters/:chapterId  chapter title and subtitle
 * PUT    /photo-books/:id/pages/:pageId/layout another layout for the page
 * DELETE /photo-books/:id/pages/:pageId/photos/:photoId
 * PUT    /photo-books/:id/pages/:pageId/captions captions on the page: on, off or as the book
 * PUT    /photo-books/:id/captions/:photoId    the user's caption for a photo
 * POST   /photo-books/:id/chapters/:chapterId/accept-suggestion  take the model's title
 * POST   /photo-books/:id/ai                   captions, chapter titles, layouts by the model
 * GET    /photo-books/:id/ai                   the state of that job
 * GET    /photo-books-layout-stats             how often the user changed the rule's and the model's layouts
 * POST   /photo-books/:id/export               render the PDF(s) in the background
 * GET    /photo-books/:id/export               the state of that job
 * GET    /photo-books-export/file/*file        download (raw, random file name,
 *                                              like the recap export)
 */

import * as fs from "fs";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import type { PhotoBookSettings, PhotoBookWeights } from "../db/schema";
import type { PhotoBookFormat } from "./photo-book-layout";
import {
  acceptPhotoBookChapterSuggestion,
  createPhotoBook,
  deletePhotoBook,
  getPhotoBookView,
  listPhotoBooks,
  photoBookFormats,
  rebuildPhotoBook,
  removePhotoFromBookPage,
  setPhotoBookCaption,
  setPhotoBookPageCaptions,
  setPhotoBookPageLayout,
  updatePhotoBook,
  updatePhotoBookChapter,
  type PhotoBookFormatOption,
  type PhotoBookSummary,
  type PhotoBookView,
} from "./photo-book.service";
import {
  getPhotoBookExportJob,
  resolvePhotoBookExportFile,
  startPhotoBookExport,
  type PhotoBookExportJob,
  type PhotoBookExportMode,
} from "./photo-book-export";
import {
  PHOTO_BOOK_AI_TASKS,
  getPhotoBookAiJob,
  layoutPickStats,
  startPhotoBookAi,
  type LayoutPickStats,
  type PhotoBookAiJob,
  type PhotoBookAiTask,
} from "./photo-book-ai";

function viewer(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "module.photos");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

export const listPhotoBooksApi = api(
  { expose: true, method: "GET", path: "/photo-books", auth: true },
  async (): Promise<{ books: PhotoBookSummary[]; formats: PhotoBookFormatOption[] }> => {
    return { books: await listPhotoBooks(viewer()), formats: photoBookFormats() };
  },
);

export interface CreatePhotoBookRequest {
  title: string;
  subtitle?: string | null;
  format?: PhotoBookFormat;
  /** A selection; or `albumId`, or `collectionId` (a collection or the basket). */
  photoIds?: number[];
  albumId?: number;
  collectionId?: number;
  /** 0..100 */
  qualityMin?: number | null;
  /** 0..100 */
  aestheticMin?: number | null;
  withoutRecognisableFaces?: boolean;
  maxPhotos?: number | null;
  /** -1 (fewer) .. 1 (more) per subject. */
  weights?: PhotoBookWeights | null;
  /** A series of near-duplicates contributes only its pick; on by default. */
  groupPicksOnly?: boolean;
}

export const createPhotoBookApi = api(
  { expose: true, method: "POST", path: "/photo-books", auth: true },
  async (req: CreatePhotoBookRequest): Promise<PhotoBookView> => {
    const userId = viewer();
    const id = await createPhotoBook(userId, req);
    return getPhotoBookView(userId, id);
  },
);

export const getPhotoBookApi = api(
  { expose: true, method: "GET", path: "/photo-books/:id", auth: true },
  async ({ id }: { id: number }): Promise<PhotoBookView> => getPhotoBookView(viewer(), id),
);

export interface UpdatePhotoBookRequest {
  id: number;
  title?: string;
  subtitle?: string | null;
  format?: PhotoBookFormat;
  coverPhotoId?: number | null;
  settings?: PhotoBookSettings;
}

export const updatePhotoBookApi = api(
  { expose: true, method: "PATCH", path: "/photo-books/:id", auth: true },
  async ({ id, ...rest }: UpdatePhotoBookRequest): Promise<PhotoBookView> => {
    const userId = viewer();
    await updatePhotoBook(userId, id, rest);
    return getPhotoBookView(userId, id);
  },
);

export const rebuildPhotoBookApi = api(
  { expose: true, method: "POST", path: "/photo-books/:id/rebuild", auth: true },
  async ({ id }: { id: number }): Promise<PhotoBookView> => {
    const userId = viewer();
    await rebuildPhotoBook(userId, id);
    return getPhotoBookView(userId, id);
  },
);

export const deletePhotoBookApi = api(
  { expose: true, method: "DELETE", path: "/photo-books/:id", auth: true },
  async ({ id }: { id: number }): Promise<void> => {
    await deletePhotoBook(viewer(), id);
  },
);

export const updatePhotoBookChapterApi = api(
  { expose: true, method: "PATCH", path: "/photo-books/:id/chapters/:chapterId", auth: true },
  async ({ id, chapterId, title, subtitle }: { id: number; chapterId: number; title?: string; subtitle?: string | null }): Promise<PhotoBookView> => {
    const userId = viewer();
    await updatePhotoBookChapter(userId, id, chapterId, { title, subtitle });
    return getPhotoBookView(userId, id);
  },
);

export const setPhotoBookPageLayoutApi = api(
  { expose: true, method: "PUT", path: "/photo-books/:id/pages/:pageId/layout", auth: true },
  async ({ id, pageId, layout }: { id: number; pageId: number; layout: string }): Promise<PhotoBookView> => {
    const userId = viewer();
    await setPhotoBookPageLayout(userId, id, pageId, layout);
    return getPhotoBookView(userId, id);
  },
);

export const removePhotoFromBookPageApi = api(
  { expose: true, method: "DELETE", path: "/photo-books/:id/pages/:pageId/photos/:photoId", auth: true },
  async ({ id, pageId, photoId }: { id: number; pageId: number; photoId: number }): Promise<PhotoBookView> => {
    const userId = viewer();
    await removePhotoFromBookPage(userId, id, pageId, photoId);
    return getPhotoBookView(userId, id);
  },
);

export const setPhotoBookPageCaptionsApi = api(
  { expose: true, method: "PUT", path: "/photo-books/:id/pages/:pageId/captions", auth: true },
  async ({ id, pageId, captions }: { id: number; pageId: number; captions: boolean | null }): Promise<PhotoBookView> => {
    const userId = viewer();
    await setPhotoBookPageCaptions(userId, id, pageId, captions);
    return getPhotoBookView(userId, id);
  },
);

export const setPhotoBookCaptionApi = api(
  { expose: true, method: "PUT", path: "/photo-books/:id/captions/:photoId", auth: true },
  async ({ id, photoId, text }: { id: number; photoId: number; text: string | null }): Promise<PhotoBookView> => {
    const userId = viewer();
    await setPhotoBookCaption(userId, id, photoId, text);
    return getPhotoBookView(userId, id);
  },
);

export const acceptPhotoBookChapterSuggestionApi = api(
  { expose: true, method: "POST", path: "/photo-books/:id/chapters/:chapterId/accept-suggestion", auth: true },
  async ({ id, chapterId }: { id: number; chapterId: number }): Promise<PhotoBookView> => {
    const userId = viewer();
    await acceptPhotoBookChapterSuggestion(userId, id, chapterId);
    return getPhotoBookView(userId, id);
  },
);

export interface PhotoBookAiStatus {
  status: "none" | PhotoBookAiJob["status"];
  job: PhotoBookAiJob | null;
}

export const startPhotoBookAiApi = api(
  { expose: true, method: "POST", path: "/photo-books/:id/ai", auth: true },
  async ({ id, tasks, overwrite }: { id: number; tasks: PhotoBookAiTask[]; overwrite?: boolean }): Promise<PhotoBookAiStatus> => {
    const userId = viewer();
    const wanted = PHOTO_BOOK_AI_TASKS.filter((t) => tasks?.includes(t));
    if (!wanted.length) throw APIError.invalidArgument(`tasks must name at least one of ${PHOTO_BOOK_AI_TASKS.join(", ")}`);
    const job = await startPhotoBookAi(userId, id, { tasks: wanted, overwrite: !!overwrite });
    return { status: job.status, job };
  },
);

export const getPhotoBookAiApi = api(
  { expose: true, method: "GET", path: "/photo-books/:id/ai", auth: true },
  async ({ id }: { id: number }): Promise<PhotoBookAiStatus> => {
    const job = getPhotoBookAiJob(viewer(), id);
    return { status: job?.status ?? "none", job };
  },
);

export const getPhotoBookLayoutStatsApi = api(
  { expose: true, method: "GET", path: "/photo-books-layout-stats", auth: true },
  async (): Promise<LayoutPickStats> => layoutPickStats(viewer()),
);

export interface PhotoBookExportStatus {
  status: "none" | PhotoBookExportJob["status"];
  mode?: PhotoBookExportMode;
  progress: number;
  error?: string;
  files: { kind: "cover" | "inside" | "book"; url: string }[];
}

function toStatus(job: PhotoBookExportJob | null): PhotoBookExportStatus {
  if (!job) return { status: "none", progress: 0, files: [] };
  return {
    status: job.status,
    mode: job.mode,
    progress: job.progress,
    error: job.error,
    files: job.files.map((f) => ({ kind: f.kind, url: `/photo-books-export/file/${f.name}` })),
  };
}

export const startPhotoBookExportApi = api(
  { expose: true, method: "POST", path: "/photo-books/:id/export", auth: true },
  async ({ id, mode }: { id: number; mode: PhotoBookExportMode }): Promise<PhotoBookExportStatus> => {
    if (mode !== "print" && mode !== "home") throw APIError.invalidArgument("mode must be print or home");
    return toStatus(await startPhotoBookExport(viewer(), id, mode));
  },
);

export const getPhotoBookExportApi = api(
  { expose: true, method: "GET", path: "/photo-books/:id/export", auth: true },
  async ({ id }: { id: number }): Promise<PhotoBookExportStatus> => toStatus(getPhotoBookExportJob(viewer(), id)),
);

export const getPhotoBookExportFile = api.raw(
  { expose: true, method: "GET", path: "/photo-books-export/file/*file", auth: false },
  async (req, res) => {
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const name = decodeURIComponent(url.pathname.replace(/^\/photo-books-export\/file\//, ""));
      const file = await resolvePhotoBookExportFile(name);
      if (!file) {
        res.statusCode = 404;
        res.end("Export not found");
        return;
      }
      const stat = await fs.promises.stat(file);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `attachment; filename="fotobuch-${name.replace(/^[0-9a-f]+-/, "")}"`);
      res.setHeader("Cache-Control", "private, max-age=3600");
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      console.error("Error serving photo book export:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal server error");
      } else {
        res.end();
      }
    }
  },
);
