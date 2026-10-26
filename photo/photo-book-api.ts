/**
 * Photo books — endpoints (documentation/plans/fotobuch.md, issue #1729).
 *
 * GET    /photo-books                          the caller's books
 * POST   /photo-books                          build one from photos or an album
 * GET    /photo-books/:id                      the book for the editor
 * PATCH  /photo-books/:id                      title, format, cover, print settings
 * POST   /photo-books/:id/rebuild              lay it out again from its source
 * DELETE /photo-books/:id
 * PATCH  /photo-books/:id/chapters/:chapterId  chapter title and subtitle
 * PUT    /photo-books/:id/pages/:pageId/layout another layout for the page
 * DELETE /photo-books/:id/pages/:pageId/photos/:photoId
 * POST   /photo-books/:id/export               render the PDF(s) in the background
 * GET    /photo-books/:id/export               the state of that job
 * GET    /photo-books-export/file/*file        download (raw, random file name,
 *                                              like the recap export)
 */

import * as fs from "fs";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import type { PhotoBookSettings } from "../db/schema";
import type { PhotoBookFormat } from "./photo-book-layout";
import {
  createPhotoBook,
  deletePhotoBook,
  getPhotoBookView,
  listPhotoBooks,
  photoBookFormats,
  rebuildPhotoBook,
  removePhotoFromBookPage,
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
  /** A selection; or `albumId`. */
  photoIds?: number[];
  albumId?: number;
  /** 0..100 */
  qualityMin?: number | null;
  /** 0..100 */
  aestheticMin?: number | null;
  withoutRecognisableFaces?: boolean;
  maxPhotos?: number | null;
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
