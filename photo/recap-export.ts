/**
 * Rueckblick-Video-Export — API-Endpoints.
 *
 * POST /recaps/:id/export        startet den Render-Job (oder liefert den
 *                                laufenden/gecachten Stand zurueck)
 * GET  /recaps/:id/export/status Poll-Endpoint fuers Frontend
 * GET  /recaps-export/file/*     Download des fertigen MP4 (Raw). Eigener
 *                                Pfad-Prefix, damit die Route nicht mit
 *                                GET /recaps/:id kollidiert; der Dateiname
 *                                enthaelt einen Content-Hash und ist ohne
 *                                Kenntnis des Rueckblick-Inhalts nicht
 *                                erratbar (gleiches Schutzniveau wie
 *                                /photos/file/*).
 */

import * as fs from "fs";
import { api, APIError } from "encore.dev/api";
import { inArray } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { photos } from "../db/schema";
import * as recapsService from "./recaps.service";
import { resolvePhotoFilePath } from "./photo";
import {
  listMusicTracks,
  pickTrackForRecap,
  resolveMusicFilePath,
} from "./recaps-music.service";
import {
  exportFileName,
  getExportJob,
  isFfmpegAvailable,
  resolveExportFilePath,
  startExport,
  type ExportJobStatus,
  type ExportPhotoInput,
} from "./recap-export.service";

function requireUser(): number {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  requirePermission(authData, "module.photos");
  requirePermission(authData, "photos.view");
  return parseInt(authData.userID);
}

interface ExportStatusResponse {
  status: "none" | ExportJobStatus["status"];
  progress: number;
  error?: string;
  /** Relative download path once the MP4 is ready. */
  download_url?: string;
}

function toResponse(job: ExportJobStatus | null): ExportStatusResponse {
  if (!job) return { status: "none", progress: 0 };
  return {
    status: job.status,
    progress: job.progress,
    error: job.error,
    ...(job.file ? { download_url: `/recaps-export/file/${job.file}` } : {}),
  };
}

async function loadRecapOrThrow(userId: number, recapId: number) {
  const recap = await recapsService.getRecapForUser(userId, recapId);
  if (!recap) throw APIError.notFound("recap not found");
  return recap;
}

/** Start rendering a recap as MP4 (idempotent while a job is running). */
export const startRecapExport = api(
  { expose: true, method: "POST", path: "/recaps/:id/export", auth: true },
  async ({ id }: { id: number }): Promise<ExportStatusResponse> => {
    const userId = requireUser();
    const recap = await loadRecapOrThrow(userId, id);
    if (recap.photo_ids.length === 0) {
      throw APIError.failedPrecondition("recap has no photos");
    }
    if (!(await isFfmpegAvailable())) {
      throw APIError.failedPrecondition(
        "ffmpeg ist auf dem Server nicht installiert — Video-Export nicht verfügbar"
      );
    }

    const rows = await dbAll<{
      id: number;
      filename: string;
      auto_crop: { x: number; y: number } | null;
    }>(
      db
        .select({
          id: photos.id,
          filename: photos.filename,
          auto_crop: photos.auto_crop,
        })
        .from(photos)
        .where(inArray(photos.id, recap.photo_ids))
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    const exportPhotos: ExportPhotoInput[] = [];
    for (const photoId of recap.photo_ids) {
      const row = byId.get(photoId);
      if (!row) continue;
      const filePath = await resolvePhotoFilePath(row.filename);
      if (!filePath) continue;
      exportPhotos.push({ id: row.id, filePath, focal: row.auto_crop });
    }
    if (exportPhotos.length === 0) {
      throw APIError.failedPrecondition("no readable photo files for this recap");
    }

    const tracks = await listMusicTracks();
    const track = pickTrackForRecap(tracks, recap.kind, recap.id);
    const musicFilePath = track ? await resolveMusicFilePath(track.id) : null;

    const job = await startExport({
      userId,
      recapId: id,
      title: recap.title,
      photos: exportPhotos,
      musicFilePath,
    });
    return toResponse(job);
  }
);

/** Poll the export state. Also detects disk-cached results after a restart. */
export const getRecapExportStatus = api(
  { expose: true, method: "GET", path: "/recaps/:id/export/status", auth: true },
  async ({ id }: { id: number }): Promise<ExportStatusResponse> => {
    const userId = requireUser();
    const job = getExportJob(userId, id);
    if (job) return toResponse(job);

    // No in-memory job (e.g. after a server restart) — a finished file may
    // still sit in the export cache.
    const recap = await loadRecapOrThrow(userId, id);
    const fileName = exportFileName(recap.id, recap.photo_ids, recap.title);
    const cached = await resolveExportFilePath(fileName);
    if (cached) {
      return {
        status: "done",
        progress: 1,
        download_url: `/recaps-export/file/${fileName}`,
      };
    }
    return { status: "none", progress: 0 };
  }
);

/** Download a finished export. */
export const getRecapExportFile = api.raw(
  { expose: true, method: "GET", path: "/recaps-export/file/*file", auth: false },
  async (req, res) => {
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const fileName = decodeURIComponent(
        url.pathname.replace(/^\/recaps-export\/file\//, "")
      );
      const filePath = await resolveExportFilePath(fileName);
      if (!filePath) {
        res.statusCode = 404;
        res.end("Export not found");
        return;
      }
      const stat = await fs.promises.stat(filePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      // Content-addressed name → safe to cache.
      res.setHeader("Cache-Control", "private, max-age=86400");
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error("Error serving recap export:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal server error");
      } else {
        res.end();
      }
    }
  }
);
