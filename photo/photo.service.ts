import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import exifr from "exifr";
import { exiftool } from "exiftool-vendored";
import { eq, and, or, sql, inArray, ilike, isNull, isNotNull, desc } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import { enqueuePhotoScan, enqueuePhotoScanBulkPerUser, DeferJobError } from "./scan-queue";
import { isUnderPressure } from "./event-loop-pressure";
import { ENABLE_LOCAL_FACES, ENABLE_LANDMARKS, ENABLE_QUALITY, ENABLE_THUMBNAIL_PREWARM, THUMBNAIL_PREWARM_WIDTHS } from "./scan-config";
export { ENABLE_LOCAL_FACES, ENABLE_LANDMARKS, ENABLE_QUALITY, ENABLE_THUMBNAIL_PREWARM, THUMBNAIL_PREWARM_WIDTHS } from "./scan-config";
import db from "../db/database";

// Dynamic import breaks the static async-init cycle between
// photo.service and scan-worker. Both modules become esbuild async-init
// (transitively via db/database.ts top-level await); a static import here
// would deadlock init_scan_worker <-> init_photo_service at boot.
function triggerWorkers(): void {
  import("./scan-worker")
    .then((m) => m.triggerWorkers())
    .catch((err) => console.error("[photo.service] triggerWorkers failed:", err));
}
import { dbFirst, dbAll, dbExec, dbInsertReturning } from '../db/adapter';
import type { IncomingMessage } from "http";
import { pipeline } from "stream/promises";
import {
  photos,
  albums,
  albumPhotos,
  albumShares,
  albumPublicLinks,
  persons,
  faces,
  userFaceAssignments,
  photoCuration,
  photoGroups,
  photoGroupMembers,
  photoLandmarks,
  photoScanQueue,
  albumUserSettings,
  users,
} from "../db/schema";
import type {
  Photo,
  PhotoWithCuration,
  CurationStatus,
  Album,
  AlbumWithPhotos,
  AlbumPhotoWithMeta,
  AlbumUserSettings,
  UpdateAlbumUserSettingsRequest,
  ViewConfig,
  ActiveView,
  PhotoCurationStats,
  CreateAlbumRequest,
  UpdateAlbumRequest,
  AddPhotoToAlbumRequest,
  BatchAlbumPhotosRequest,
  ListPhotoAlbumsResponse,
  ShareAlbumRequest,
  GetAlbumSharesResponse,
  RemoveAlbumShareRequest,
  AlbumPublicLink,
  PublicAlbumResponse,
  ListAlbumsResponse,
  ListPhotosResponse,
  ListPhotoIndexResponse,
  PhotoIndexEntry,
  PhotoDetailsBatchResponse,
  DeleteResponse,
  Person,
  ListPersonsResponse,
  PersonDetails,
  MergePersonsRequest,
  PhotoGroup,
  ListGroupsResponse,
  FindGroupsResponse,
  Face,
  FaceBBox,
  LandmarkBBox,
} from "../db/types";
import { resizeImageInPool } from "./image-pool";
import { getHeicDecodeCached, setHeicDecodeCached } from "./heic-cache";
import { fetchWithTimeout, ML_RPC_QUICK_TIMEOUT_MS } from "./rpc-timeout";
import {
  buildPhotoFilterConditions,
  type PhotoFilterParams,
} from "./photo.filters";

console.log("[boot] photo/photo.service.ts: all imports resolved");

// heic-convert is a CJS module without TS types; load via createRequire
const _require = createRequire(import.meta.url);
type HeicConvertFn = (opts: { buffer: ArrayBuffer | Buffer; format: 'JPEG' | 'PNG'; quality: number }) => Promise<ArrayBuffer>;
const heicConvert: HeicConvertFn = _require('heic-convert');

const nowSql = sql`NOW()`
/** COALESCE(taken_at, created_at) – fallback to upload date if no EXIF date available */
const photoDateOrder = sql`COALESCE(${photos.taken_at}, ${photos.created_at})`
/** Raw SQL fragment for use inside subqueries referencing the photos table alias "p" */
const rawCoalesceDate = sql.raw('COALESCE(p.taken_at, p.created_at)')
const rawFalse = sql.raw('false')

export const UPLOAD_DIR = path.resolve(process.env.PHOTO_UPLOAD_DIR || "uploads/photos");
export const THUMBNAIL_DIR = path.resolve(process.env.PHOTO_THUMBNAIL_DIR || "uploads/thumbnails");

/**
 * Resolve the on-disk path for a photo row. Library-linked photos
 * (link-import mode) have `external_path` set and their `filename` is a
 * synthetic key that does not exist under UPLOAD_DIR, so any caller that
 * needs the actual image bytes must go through this helper.
 */
export function getPhotoDiskPath(photo: { filename: string; external_path?: string | null }): string {
  return photo.external_path ? photo.external_path : path.join(UPLOAD_DIR, photo.filename);
}
const INSIGHTFACE_SERVICE_URL = process.env.INSIGHTFACE_SERVICE_URL || "http://localhost:8000";

export const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
  "image/heic", "image/heif", "image/tiff", "image/bmp", "image/svg+xml",
]);

/** File extensions that map to a supported MIME type. Used by the library
 *  scanner to filter directory listings before touching files. */
export const SUPPORTED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp",
  ".heic", ".heif", ".tif", ".tiff", ".bmp", ".svg",
]);

export function guessMimeFromExt(ext: string): string | null {
  const e = ext.toLowerCase();
  switch (e) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".heic": return "image/heic";
    case ".heif": return "image/heif";
    case ".tif":
    case ".tiff": return "image/tiff";
    case ".bmp": return "image/bmp";
    case ".svg": return "image/svg+xml";
    default: return null;
  }
}
const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || "http://localhost:8001";
// Must match the validator bounds on TextSearchRequest in
// embedding_service/app/models/schemas.py. Sending k/query outside these
// bounds causes the embedding service to reject the request with 422.
const EMBEDDING_TEXT_SEARCH_MAX_K = 1000;
const EMBEDDING_TEXT_SEARCH_MAX_QUERY_LEN = 500;
const EXIF_WRITE_TIMEOUT_MS = parseInt(process.env.EXIF_WRITE_TIMEOUT_MS || "8000", 10);
const EXIF_WRITABLE_EXTENSIONS = new Set([".jpg", ".jpeg", ".tif", ".tiff", ".png"]);

function getUploadMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

// Distance threshold for face matching.
// InsightFace uses cosine similarity (higher is better, 1.0 is identical).
// We convert it to a "distance" if we want, or just use similarity directly.
// The config value is now treated as minimum similarity for a match.
const FACE_SIMILARITY_THRESHOLD = parseFloat(process.env.FACE_DISTANCE_THRESHOLD || "0.45");
const LANDMARK_SERVICE_URL = process.env.LANDMARK_SERVICE_URL || "http://localhost:8002";

// ── AI system user for virtual curation votes ────────────────────────────────
const AI_USER_EMAIL = "ai@system.local";
const AI_FAV_THRESHOLD = parseFloat(process.env.AI_FAV_THRESHOLD || "0.7");
const AI_HIDE_THRESHOLD = parseFloat(process.env.AI_HIDE_THRESHOLD || "0.3");
let _aiUserId: number | null | undefined; // undefined = not yet queried

async function getAiUserId(): Promise<number | null> {
  if (_aiUserId !== undefined) return _aiUserId;
  const row = await dbFirst<{ id: number }>(
    db.select({ id: users.id }).from(users).where(eq(users.email, AI_USER_EMAIL))
  );
  _aiUserId = row?.id ?? null;
  return _aiUserId;
}

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
/** Temp staging dir for uploads before they are renamed into their final YYYY/YYYY-MM/... slot. */
const UPLOAD_TMP_DIR = path.join(UPLOAD_DIR, "_tmp");
if (!fs.existsSync(UPLOAD_TMP_DIR)) {
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
}
if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

// ---------- Photo storage layout (YYYY/YYYY-MM/YYYY-MM-DD_at_HH.MM.SS_NN.ext) ----------

const pad2 = (n: number) => n.toString().padStart(2, "0");

/**
 * Break a Date into its local Y/M/D/h/m/s components honoring the server's
 * configured timezone (process.env.TZ). Using the default `toLocaleString`
 * locale 'en-CA' gives a stable `YYYY-MM-DD HH:MM:SS` format we can parse.
 */
function localDateParts(d: Date): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const tz = process.env.TZ || undefined;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  // Some runtimes return "24" for midnight hour — normalize to "00".
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/**
 * Normalize an image extension. Falls back to `.jpg` when the source filename
 * has no recognizable extension. Returned value is lowercase and includes the
 * leading dot.
 */
export function normalizeImageExt(originalName: string, mimeType?: string): string {
  const ext = path.extname(originalName).toLowerCase();
  if (ext) return ext;
  const mt = (mimeType || "").toLowerCase().split(";")[0].trim();
  switch (mt) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    case "image/tiff":
      return ".tiff";
    case "image/bmp":
      return ".bmp";
    case "image/svg+xml":
      return ".svg";
    default:
      return ".jpg";
  }
}

/**
 * Pick the timestamp used for the storage path. Prefers EXIF `takenAt`, falls
 * back to upload time.
 */
export function pickStorageTimestamp(takenAtIso: string | null | undefined): Date {
  if (takenAtIso) {
    const d = new Date(takenAtIso);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

/**
 * Reserve an output path under `UPLOAD_DIR` following the
 * `YYYY/YYYY-MM/YYYY-MM-DD_at_HH.MM.SS_NN.<ext>` convention. The method
 * atomically creates an empty placeholder file for the returned path using
 * `O_EXCL`, so two concurrent callers cannot reserve the same slot. The caller
 * is responsible for writing the actual contents into `absPath` (or moving a
 * prepared temp file over it with `fs.rename`, which will replace the empty
 * placeholder on the same filesystem).
 *
 * Returns both the filesystem path and the `filename` value to persist in the
 * DB (relative to `UPLOAD_DIR`, forward-slash separated).
 */
export async function reserveStoragePath(
  timestamp: Date,
  ext: string
): Promise<{ absPath: string; relPath: string }> {
  const p = localDateParts(timestamp);
  const subdir = path.join(`${p.year}`, `${p.year}-${p.month}`);
  const absDir = path.join(UPLOAD_DIR, subdir);
  await fs.promises.mkdir(absDir, { recursive: true });

  const baseStem = `${p.year}-${p.month}-${p.day}_at_${p.hour}.${p.minute}.${p.second}`;
  const normalizedExt = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;

  // Try counters 00..99 first; fall back to a wider range just in case.
  for (let i = 0; i < 10000; i++) {
    const name = `${baseStem}_${pad2(i)}${normalizedExt}`;
    const absPath = path.join(absDir, name);
    try {
      // wx: fail if the file already exists → atomic slot reservation.
      const handle = await fs.promises.open(absPath, "wx");
      await handle.close();
      const relPath = path.posix.join(`${p.year}`, `${p.year}-${p.month}`, name);
      return { absPath, relPath };
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("Could not reserve a unique photo filename slot");
}

// ---------- People & Faces ----------

async function callInsightFaceDetect(filePath: string): Promise<{ faces: any[], width: number, height: number }> {
  const formData = new FormData();
  const fileData = await fs.promises.readFile(filePath);
  const blob = new Blob([fileData], { type: getUploadMimeType(filePath) });
  formData.append('file', blob, path.basename(filePath));

  const response = await fetchWithTimeout(`${INSIGHTFACE_SERVICE_URL}/detect`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`InsightFace service returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as { faces: any[], width: number, height: number };
  return data;
}

async function callEmbeddingServiceUpload(
  photoId: string,
  filePath: string,
  metadata: { timestamp?: string; camera_id?: string; face_ids?: string[] },
  force: boolean = false
): Promise<void> {
  const formData = new FormData();
  const fileData = await fs.promises.readFile(filePath);
  const blob = new Blob([fileData], { type: getUploadMimeType(filePath) });

  formData.append('file', blob, path.basename(filePath));
  formData.append('photo_id', photoId);
  formData.append('file_path', filePath);
  if (metadata.timestamp) formData.append('timestamp', metadata.timestamp);
  if (metadata.camera_id) formData.append('camera_id', metadata.camera_id);
  if (metadata.face_ids && metadata.face_ids.length > 0) {
    formData.append('face_ids', metadata.face_ids.join(','));
  }
  if (force) formData.append('force', '1');

  const response = await fetchWithTimeout(`${EMBEDDING_SERVICE_URL}/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding service returned ${response.status}: ${errorText}`);
  }
  console.log(`Successfully uploaded photo ${photoId} to embedding service.`);
}

export async function indexPhotoEmbeddings(photoId: number, force: boolean = false): Promise<void> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(eq(photos.id, photoId))
  );
  if (!photo) return;

  const filePath = getPhotoDiskPath(photo);
  if (!fs.existsSync(filePath)) return;

  // Get face IDs for this photo (global — no user filter needed)
  const photoFaces = await dbAll<{ id: number }>(db.select({ id: faces.id }).from(faces).where(eq(faces.photo_id, photoId)));
  const faceIds = photoFaces.map(f => f.id.toString());

  await callEmbeddingServiceUpload(photoId.toString(), filePath, {
    timestamp: photo.taken_at ?? photo.created_at ?? undefined,
    face_ids: faceIds,
  }, force);
}

/**
 * Compute the auto-crop focus point for a photo based on detected faces and landmarks.
 * Faces take priority; if none exist, the largest/most confident landmark is used.
 * The result is a normalized {x, y} center (0..1) stored on the photo row.
 */
export async function computeAndStoreAutoCrop(userId: number, photoId: number): Promise<void> {
  // Collect non-ignored face bboxes (join faces + user_face_assignments)
  const faceRows = await dbAll<{ bbox: string }>(
    db.select({ bbox: faces.bbox })
      .from(faces)
      .innerJoin(userFaceAssignments, and(
        eq(userFaceAssignments.face_id, faces.id),
        eq(userFaceAssignments.user_id, userId),
        eq(userFaceAssignments.ignored, false)
      ))
      .where(eq(faces.photo_id, photoId))
  );

  const faceBboxes = faceRows.map(r => JSON.parse(r.bbox) as { x: number; y: number; width: number; height: number });

  if (faceBboxes.length > 0) {
    // Compute weighted center across all faces (weighted by area)
    let totalWeight = 0;
    let cx = 0;
    let cy = 0;
    for (const b of faceBboxes) {
      const area = b.width * b.height;
      const weight = Math.max(area, 0.001);
      cx += (b.x + b.width / 2) * weight;
      cy += (b.y + b.height / 2) * weight;
      totalWeight += weight;
    }
    cx /= totalWeight;
    cy /= totalWeight;

    await dbExec(
      db.update(photos).set({ auto_crop: { x: Math.round(cx * 1000) / 1000, y: Math.round(cy * 1000) / 1000 } })
        .where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
    );
    return;
  }

  // Fallback: use landmark with highest confidence (global — no user filter)
  const landmarkRows = await dbAll<{ bbox: string; confidence: number }>(
    db.select({ bbox: photoLandmarks.bbox, confidence: photoLandmarks.confidence })
      .from(photoLandmarks)
      .where(eq(photoLandmarks.photo_id, photoId))
  );

  if (landmarkRows.length > 0) {
    // Pick the landmark with the highest confidence
    const best = landmarkRows.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const bbox = JSON.parse(best.bbox) as { x: number; y: number; width: number; height: number };
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;

    await dbExec(
      db.update(photos).set({ auto_crop: { x: Math.round(cx * 1000) / 1000, y: Math.round(cy * 1000) / 1000 } })
        .where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
    );
    return;
  }

  // No faces or landmarks – clear auto_crop so default centering is used
  await dbExec(
    db.update(photos).set({ auto_crop: null })
      .where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );
}

/**
 * Detect faces in a photo using InsightFace (global, runs once per photo).
 * Stores raw detection results (bbox + embedding) in the `faces` table.
 * If faces already exist for this photo and force is false, detection is skipped.
 */
/** Check whether any faces have been detected for a photo. */
export async function hasFacesForPhoto(photoId: number): Promise<boolean> {
  const row = await dbFirst<{ id: number }>(
    db.select({ id: faces.id }).from(faces).where(eq(faces.photo_id, photoId))
  );
  return row != null;
}

export async function detectPhotoFaces(photoId: number, force: boolean = false): Promise<void> {
  if (!ENABLE_LOCAL_FACES) {
    console.log("Local face indexing is disabled via ENABLE_LOCAL_FACES=false");
    return;
  }

  // Check if faces already exist for this photo (skip detection if not forced)
  if (!force) {
    const existing = await dbFirst<{ id: number }>(
      db.select({ id: faces.id }).from(faces).where(eq(faces.photo_id, photoId)).limit(1)
    );
    if (existing) {
      console.log(`Faces already detected for photo ${photoId}, skipping detection`);
      return;
    }
  }

  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(eq(photos.id, photoId))
  );
  if (!photo) return;

  const filePath = getPhotoDiskPath(photo);
  if (!fs.existsSync(filePath)) return;

  let processingPath = filePath;
  let tempPath: string | null = null;

  const ext = path.extname(photo.filename).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    try {
      tempPath = path.join(UPLOAD_DIR, `temp_${photoId}_${Date.now()}.jpg`);
      const jpegBuffer = await convertHeicToJpeg(filePath);
      await fs.promises.writeFile(tempPath, jpegBuffer);
      processingPath = tempPath;
    } catch (err) {
      console.error(`Error converting HEIC photo ${photoId}:`, err);
      return;
    }
  }

  // If forced, remove old face rows (cascade will clean up user_face_assignments)
  if (force) {
    await dbExec(db.delete(faces).where(eq(faces.photo_id, photoId)));
  }

  try {
    const detectResult = await callInsightFaceDetect(processingPath);
    const facesDetected = detectResult.faces;
    const imgWidth = detectResult.width;
    const imgHeight = detectResult.height;

    console.log(`Detected ${facesDetected.length} faces in photo ${photoId} (size: ${imgWidth}x${imgHeight})`);

    for (const f of facesDetected) {
      const bbox = {
        x: f.bbox[0] / imgWidth,
        y: f.bbox[1] / imgHeight,
        width: (f.bbox[2] - f.bbox[0]) / imgWidth,
        height: (f.bbox[3] - f.bbox[1]) / imgHeight
      };

      await dbInsertReturning<typeof faces.$inferSelect>(
        db.insert(faces)
          .values({
            photo_id: photoId,
            bbox: JSON.stringify(bbox),
            embedding: JSON.stringify(f.embedding),
            quality: 100,
          })
          .returning()
      );
    }
  } catch (err) {
    console.error(`Error detecting faces for photo ${photoId}:`, err);
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try { await fs.promises.unlink(tempPath); } catch (_e) { /* ignore */ }
    }
  }
}

/** Look up the owner of a photo. Returns undefined if the photo doesn't exist. */
export async function getPhotoOwnerId(photoId: number): Promise<number | undefined> {
  const row = await dbFirst<{ user_id: number }>(
    db.select({ user_id: photos.user_id }).from(photos).where(eq(photos.id, photoId))
  );
  return row?.user_id;
}

/**
 * Find all users who have access to a photo:
 *   1. The photo owner
 *   2. Users who have the photo in a shared album
 * Returns unique user IDs.
 */
export async function getUsersWithPhotoAccess(photoId: number): Promise<number[]> {
  const rows = await db.execute<{ user_id: number }>(sql`
    SELECT DISTINCT u.user_id FROM (
      -- Photo owner
      SELECT user_id FROM photos WHERE id = ${photoId}
      UNION
      -- Users with album access (album shared with them and photo is in that album)
      SELECT asr.user_id
      FROM album_shares asr
      INNER JOIN album_photos ap ON ap.album_id = asr.album_id
      WHERE ap.photo_id = ${photoId}
    ) u
  `);
  return rows.rows.map((r) => r.user_id);
}

/**
 * Enqueue face_assignment for all users who have access to a photo.
 * Called after face_detection completes to ensure every user gets face assignments.
 */
export async function enqueueFaceAssignmentForAllUsers(photoId: number): Promise<void> {
  if (!ENABLE_LOCAL_FACES) return;
  const userIds = await getUsersWithPhotoAccess(photoId);
  if (userIds.length === 0) return;
  // Single bulk insert instead of N sequential enqueuePhotoScan() calls.
  // For albums shared with many users this is the difference between
  // one DB round-trip and hundreds.
  await enqueuePhotoScanBulkPerUser(photoId, userIds, "face_assignment");
  triggerWorkers();
}

/**
 * Assign detected faces to persons for a specific user (per-user, runs per user per photo).
 * Creates user_face_assignments rows with auto-matched person_id based on cosine similarity.
 * Respects previously ignored faces (by bbox overlap).
 */
export async function assignFacesForUser(userId: number, photoId: number, resetIgnored: boolean = false): Promise<void> {
  if (!ENABLE_LOCAL_FACES) return;

  // Check if face detection is actively running for this photo.
  // Only defer when detection is pending/processing — if it was never enqueued,
  // already done, or failed, proceed gracefully instead of blocking the queue.
  const detectionRunning = await dbFirst<{ id: number }>(
    db.select({ id: photoScanQueue.id }).from(photoScanQueue)
      .where(and(
        eq(photoScanQueue.photo_id, photoId),
        sql`${photoScanQueue.service} = 'face_detection'`,
        inArray(photoScanQueue.status, ["pending", "processing"]),
      ))
  );
  if (detectionRunning) {
    throw new DeferJobError(`face_detection not yet done for photo ${photoId}`);
  }
  // No active detection → proceed. There may still be faces from a previous
  // run, and we'll handle "no faces" gracefully below.

  // Get all detected faces for this photo (global)
  const detectedFaces = await dbAll<typeof faces.$inferSelect>(
    db.select().from(faces).where(eq(faces.photo_id, photoId))
  );
  if (detectedFaces.length === 0) return;

  // Get existing ignored assignments for this user+photo to preserve them
  const ignoredAssignments = resetIgnored ? [] : await dbAll<{
    face_id: number; bbox: string;
  }>(
    db.select({ face_id: userFaceAssignments.face_id, bbox: faces.bbox })
      .from(userFaceAssignments)
      .innerJoin(faces, eq(faces.id, userFaceAssignments.face_id))
      .where(and(
        eq(userFaceAssignments.user_id, userId),
        eq(faces.photo_id, photoId),
        eq(userFaceAssignments.ignored, true)
      ))
  );

  // Remove existing non-ignored assignments for this user+photo
  if (resetIgnored) {
    // Remove ALL assignments for this user+photo
    const photoFaceIds = detectedFaces.map(f => f.id);
    if (photoFaceIds.length > 0) {
      await dbExec(
        db.delete(userFaceAssignments).where(and(
          eq(userFaceAssignments.user_id, userId),
          inArray(userFaceAssignments.face_id, photoFaceIds)
        ))
      );
    }
  } else {
    // Remove only non-ignored assignments
    const photoFaceIds = detectedFaces.map(f => f.id);
    if (photoFaceIds.length > 0) {
      await dbExec(
        db.delete(userFaceAssignments).where(and(
          eq(userFaceAssignments.user_id, userId),
          inArray(userFaceAssignments.face_id, photoFaceIds),
          eq(userFaceAssignments.ignored, false)
        ))
      );
    }
  }

  for (const face of detectedFaces) {
    const bbox = JSON.parse(face.bbox);

    // Check if this face was ignored by this user (by bbox overlap)
    const isIgnored = ignoredAssignments.some(ia => {
      const iBbox = JSON.parse(ia.bbox);
      return calculateOverlap(bbox, iBbox) > 0.8;
    });
    if (isIgnored) continue;

    // Check if assignment already exists (from a previous run)
    const existingAssignment = await dbFirst<{ face_id: number }>(
      db.select({ face_id: userFaceAssignments.face_id })
        .from(userFaceAssignments)
        .where(and(eq(userFaceAssignments.user_id, userId), eq(userFaceAssignments.face_id, face.id)))
    );
    if (existingAssignment) continue;

    const embedding = JSON.parse(face.embedding as string) as number[];
    const match = await findBestPersonMatch(userId, embedding);

    let personId = match?.personId;
    if (!personId) {
      // Try to inherit the person name from existing assignments by other users
      // (e.g. the photo owner already named this person).
      const sourceAssignment = await dbFirst<{ person_name: string }>(
        db.select({ person_name: persons.name })
          .from(userFaceAssignments)
          .innerJoin(persons, eq(persons.id, userFaceAssignments.person_id))
          .where(and(
            eq(userFaceAssignments.face_id, face.id),
            sql`${persons.name} != 'Unbenannt'`,
            eq(userFaceAssignments.ignored, false),
          ))
      );

      const personName = sourceAssignment?.person_name ?? "Unbenannt";

      // If the user already has a person with the same name, reuse it
      // so that faces from the same source person stay grouped.
      if (personName !== "Unbenannt") {
        const existingPerson = await dbFirst<{ id: number }>(
          db.select({ id: persons.id })
            .from(persons)
            .where(and(eq(persons.user_id, userId), eq(persons.name, personName)))
        );
        if (existingPerson) personId = existingPerson.id;
      }

      if (!personId) {
        const newPerson = await dbInsertReturning<typeof persons.$inferSelect>(
          db.insert(persons).values({ user_id: userId, name: personName }).returning()
        );
        personId = newPerson!.id;
      }
    }

    // Insert user_face_assignment
    await dbExec(
      db.insert(userFaceAssignments)
        .values({ user_id: userId, face_id: face.id, person_id: personId })
        .onConflictDoNothing()
    );

    // Update person cover face if needed
    const currentPerson = await dbFirst<typeof persons.$inferSelect>(
      db.select().from(persons).where(eq(persons.id, personId))
    );
    let needsCoverUpdate = false;
    if (currentPerson) {
      if (!currentPerson.cover_face_id) {
        needsCoverUpdate = true;
      } else {
        const coverFaceExists = await dbFirst<{ id: number }>(
          db.select({ id: faces.id }).from(faces).where(eq(faces.id, currentPerson.cover_face_id))
        );
        if (!coverFaceExists) needsCoverUpdate = true;
      }
    }

    if (needsCoverUpdate) {
      await dbExec(db.update(persons).set({
        cover_face_id: face.id,
        updated_at: new Date().toISOString(),
      }).where(eq(persons.id, personId)));
    } else {
      await dbExec(db.update(persons).set({
        updated_at: new Date().toISOString(),
      }).where(eq(persons.id, personId)));
    }
  }

  // Recompute auto-crop focus point after face assignment changes
  try {
    await computeAndStoreAutoCrop(userId, photoId);
  } catch (err) {
    console.error(`Error computing auto-crop for photo ${photoId}:`, err);
  }
}

/**
 * Legacy wrapper: detect faces + assign for owner. Used by scan-worker for backward compat.
 */
export async function indexPhotoFaces(userId: number, photoId: number, force: boolean = false): Promise<void> {
  await detectPhotoFaces(photoId, force);
  await assignFacesForUser(userId, photoId, force);
}

export interface ExifMetadata {
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  /** IPTC Keywords / XMP dc:subject — candidate tags. */
  keywords: string[];
  /** XMP xmp:Rating (0–5). >= 4 is treated as favourite on import. */
  rating: number | null;
  /** IPTC By-line / XMP dc:creator — creator/photographer name. */
  author: string | null;
  /** IPTC Headline. */
  headline: string | null;
  /** XMP dc:title (language-alternative resolved to x-default). */
  title: string | null;
  /** IPTC Copyright / EXIF Copyright. */
  copyright: string | null;
  /** IPTC Credit. */
  credit: string | null;
  /** IPTC City. */
  city: string | null;
  /** IPTC Province-State. */
  state: string | null;
  /** IPTC Country-PrimaryLocationName. */
  country: string | null;
  /**
   * XMP `xmp:Rating` — integer 1..5 for a star rating, or `null` when the tag is
   * absent. `-1` (rejected) and `0` (unrated) are normalised to `null` so they
   * are indistinguishable from a missing tag downstream.
   */
  rating: number | null;
}

/**
 * Parse an IPTC DateCreated (YYYYMMDD or YYYY-MM-DD) + optional TimeCreated
 * (HHMMSS[±HHMM] or HH:MM:SS) into an ISO-8601 string. Returns null when the
 * fields are missing or unparseable.
 *
 * Exported for unit tests.
 */
export function parseIptcDate(date: unknown, time: unknown): string | null {
  if (!date) return null;
  const dateStr = typeof date === "string" ? date : String(date);
  // Accept "YYYYMMDD" or "YYYY-MM-DD" or "YYYY:MM:DD".
  const dateMatch = dateStr.match(/^(\d{4})[:-]?(\d{2})[:-]?(\d{2})/);
  if (!dateMatch) return null;
  const [, yyyy, mm, dd] = dateMatch;
  let hh = "00";
  let mi = "00";
  let ss = "00";
  let tz = "Z";
  if (time) {
    const timeStr = typeof time === "string" ? time : String(time);
    const timeMatch = timeStr.match(/^(\d{2}):?(\d{2}):?(\d{2})([+-]\d{2}:?\d{2})?/);
    if (timeMatch) {
      hh = timeMatch[1];
      mi = timeMatch[2];
      ss = timeMatch[3];
      if (timeMatch[4]) {
        tz = timeMatch[4].includes(":") ? timeMatch[4] : `${timeMatch[4].slice(0, 3)}:${timeMatch[4].slice(3)}`;
      }
    }
  }
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${tz}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function asString(v: unknown): string | null {
  // Unwrap XMP Language Alternatives — exifr returns dc:title / dc:description
  // as `{ lang: "x-default", value: "..." }` (single) or an array of such
  // objects (multiple locales). Pick x-default, falling back to the first.
  if (Array.isArray(v)) {
    const xDefault = v.find((x) => x && typeof x === "object" && (x as any).lang === "x-default");
    const pick = xDefault ?? v[0];
    return pick && typeof pick === "object" && "value" in pick
      ? asString((pick as { value: unknown }).value)
      : null;
  }
  if (v && typeof v === "object" && "value" in v) {
    return asString((v as { value: unknown }).value);
  }
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Normalise XMP `xmp:Rating` to an integer 1..5. Lightroom etc. write the rating
 * as either a number or a stringified number; `-1` means "rejected" and `0`
 * means "unrated" — both collapse to `null` so callers only see actual stars.
 * Exported for unit tests.
 */
export function parseXmpRating(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r < 1 || r > 5) return null;
  return r;
}

/**
 * Build the "Rating-N" keyword used to expose a photo's star rating as a tag.
 * The hyphen keeps the label a single whitespace-free token so searches
 * entered as "Rating-3" aren't tokenised into ["Rating", "3"] by the natural
 * query parser. Returns null when `rating` is falsy so callers can just
 * spread it into the keyword array.
 */
export function ratingKeyword(rating: number | null | undefined): string | null {
  if (!rating || rating < 1 || rating > 5) return null;
  return `Rating-${rating}`;
}

/**
 * Append the "Rating-N" keyword derived from `rating` to an existing keyword
 * list. Case-insensitive de-dup keeps re-imports stable and respects any
 * tooling that already wrote an identical tag into the file itself.
 */
export function mergeRatingKeyword(keywords: string[], rating: number | null): string[] {
  const extra = ratingKeyword(rating);
  if (!extra) return keywords;
  const lower = extra.toLowerCase();
  if (keywords.some((k) => k.toLowerCase() === lower)) return keywords;
  return [...keywords, extra];
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter((x) => x.length > 0);
  }
  const s = asString(v);
  if (!s) return [];
  // Some encoders store keywords as a single semicolon- or comma-separated string.
  return s
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Extract EXIF, IPTC and XMP metadata from an image file. Exported for tests.
 *
 * Always returns a defined object — on parse errors every field falls back to
 * its "not present" value (null / empty array) so callers don't need to handle
 * exceptions.
 */
export async function getExifMetadata(filePath: string): Promise<ExifMetadata> {
  const empty: ExifMetadata = {
    takenAt: null,
    latitude: null,
    longitude: null,
    description: null,
    keywords: [],
    rating: null,
    author: null,
    headline: null,
    title: null,
    copyright: null,
    credit: null,
    city: null,
    state: null,
    country: null,
    rating: null,
  };
  try {
    const data = await exifr.parse(filePath, { gps: true, xmp: true, iptc: true });
    let takenAt: string | null = null;
    if (data?.DateTimeOriginal) {
      takenAt = new Date(data.DateTimeOriginal).toISOString();
    } else if (data?.CreateDate) {
      takenAt = new Date(data.CreateDate).toISOString();
    } else {
      // Fall back to IPTC DateCreated/TimeCreated when EXIF timestamps are missing.
      takenAt = parseIptcDate(data?.DateCreated, data?.TimeCreated);
    }
    // Description — prefer EXIF/XMP fields, fall back to IPTC Caption-Abstract.
    // exifr normalizes XMP dc:description to lowercase `description`.
    const description: string | null =
      asString(data?.ImageDescription) ??
      asString(data?.Description) ??
      asString(data?.description) ??
      asString(data?.UserComment) ??
      asString(data?.Caption) ??
      asString(data?.["Caption-Abstract"]) ??
      null;
    // Keywords — IPTC Keywords or XMP dc:subject (exifr emits `subject`).
    const keywords = asStringArray(
      data?.Keywords ?? data?.subject
    );
    const author =
      asString(data?.Byline) ??
      asString(data?.["By-line"]) ??
      asString(data?.Artist) ??
      asString(data?.Creator) ??
      asString(data?.creator) ??
      null;
    const headline = asString(data?.Headline);
    // XMP dc:title — exifr normalises to lowercase `title`.
    const title = asString(data?.title);
    const copyright =
      asString(data?.CopyrightNotice) ??
      asString(data?.Copyright) ??
      asString(data?.Rights) ??
      asString(data?.rights) ??
      null;
    const credit = asString(data?.Credit);
    const city = asString(data?.City);
    const state = asString(data?.["Province-State"]) ?? asString(data?.State);
    const country =
      asString(data?.["Country-PrimaryLocationName"]) ??
      asString(data?.Country) ??
      null;
    const rating = parseXmpRating(data?.Rating ?? data?.rating);
    return {
      takenAt,
      latitude: data?.latitude ?? null,
      longitude: data?.longitude ?? null,
      description,
      keywords,
      rating,
      author,
      headline,
      title,
      copyright,
      credit,
      city,
      state,
      country,
      rating,
    };
  } catch (err) {
    console.error("Error parsing EXIF data:", err);
    return empty;
  }
}

async function getExifDate(filePath: string): Promise<string | null> {
  return (await getExifMetadata(filePath)).takenAt;
}

interface GeocodeResult {
  /** Concise location, e.g. "Schlossplatz 4, Stuttgart" */
  displayName: string;
  /** Short label for title bars, e.g. "Schlossplatz" or "Stuttgart" */
  shortName: string | null;
  city: string | null;
  country: string | null;
}

/**
 * Build a concise location string from Nominatim address components.
 * Format: "Straße Hausnr, Stadt" (German style: house number after street).
 * Falls back gracefully when fields are missing.
 */
function buildLocationName(addr: Record<string, any>): { displayName: string; shortName: string | null } {
  const road = addr.road ?? addr.pedestrian ?? addr.footway ?? addr.path ?? null;
  const houseNumber = addr.house_number ?? null;
  const city = addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? null;
  const tourism = addr.tourism ?? addr.amenity ?? addr.building ?? addr.leisure ?? null;

  // Short name: most specific place identifier for title bars
  const shortName = tourism ?? road ?? city ?? null;

  // Build concise display name
  const parts: string[] = [];

  // Street + house number (German format: "Straße 4")
  if (road) {
    parts.push(houseNumber ? `${road} ${houseNumber}` : road);
  } else if (tourism) {
    parts.push(tourism);
  }

  // City (only if different from what we already have)
  if (city && city !== road && city !== tourism) {
    parts.push(city);
  }

  const displayName = parts.join(", ");
  return { displayName, shortName };
}

async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResult> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=de,en,local`;
    const res = await fetch(url, {
      headers: { "User-Agent": "fk-encore-photo-app/1.0" },
    });
    if (!res.ok) return { displayName: "", shortName: null, city: null, country: null };
    const data = await res.json() as Record<string, any>;
    const addr = data.address ?? {};
    const city = addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? null;
    const country = addr.country ?? null;
    const { displayName, shortName } = buildLocationName(addr);
    return {
      displayName: displayName || city || data.display_name || "",
      shortName,
      city,
      country,
    };
  } catch (err) {
    console.error("Nominatim reverse geocoding failed:", err);
    return { displayName: "", shortName: null, city: null, country: null };
  }
}

async function geocodePhotoLocation(photoId: number, lat: number, lon: number): Promise<void> {
  const geo = await reverseGeocode(lat, lon);
  await dbExec(
    db.update(photos)
      .set({
        location_name: geo.displayName || null,
        location_short: geo.shortName || null,
        location_city: geo.city,
        location_country: geo.country,
      })
      .where(eq(photos.id, photoId))
  );
}

/**
 * Build location fields directly from the IPTC location block written into the
 * file (e.g. by Lightroom's Map module or camera apps like Halide). Returns a
 * partial update payload or null if no IPTC location data is present.
 *
 * Using these values lets us skip the Nominatim round-trip on upload.
 *
 * Exported for unit tests.
 */
/**
 * Build the description string written to `photos.description`.
 *
 * Base text comes from EXIF/XMP description (with IPTC Caption-Abstract /
 * IPTC Headline as fallbacks). If XMP dc:title is also present and not
 * already contained in the base, it is appended, separated by a blank line.
 */
export function combineDescription(meta: ExifMetadata): string | null {
  const base = meta.description ?? meta.headline ?? null;
  const title = meta.title;
  if (!base && !title) return null;
  if (!base) return title;
  if (!title || base.includes(title)) return base;
  return `${base}\n\n${title}`;
}

export function iptcLocationUpdate(meta: ExifMetadata): {
  location_name: string;
  location_short: string | null;
  location_city: string | null;
  location_country: string | null;
} | null {
  const city = meta.city;
  const state = meta.state;
  const country = meta.country;
  if (!city && !state && !country) return null;
  // Display name follows the same shape reverseGeocode produces: "City, Country".
  const displayParts = [city ?? state, country].filter((p): p is string => !!p);
  const displayName = displayParts.join(", ");
  return {
    location_name: displayName,
    location_short: city ?? state ?? null,
    location_city: city,
    location_country: country,
  };
}

/**
 * Scan-queue job handler for geocoding.
 * 1. If the photo has no GPS coordinates, tries EXIF extraction.
 * 2. If GPS is available, calls Nominatim for reverse-geocoding.
 * 3. Succeeds silently when no GPS data exists (nothing to geocode).
 */
export async function indexPhotoGeocoding(photoId: number, force = false): Promise<void> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(eq(photos.id, photoId))
  );
  if (!photo) return;

  let lat = photo.latitude;
  let lon = photo.longitude;
  let iptcLoc: ReturnType<typeof iptcLocationUpdate> = null;

  // Try EXIF extraction if no GPS stored yet — or to discover IPTC location.
  const filePath = getPhotoDiskPath(photo);
  if (fs.existsSync(filePath)) {
    const exifMeta = await getExifMetadata(filePath);
    if ((lat === null || lon === null) && exifMeta.latitude !== null && exifMeta.longitude !== null) {
      lat = exifMeta.latitude;
      lon = exifMeta.longitude;
      await dbExec(
        db.update(photos).set({ latitude: lat, longitude: lon }).where(eq(photos.id, photoId))
      );
    }
    iptcLoc = iptcLocationUpdate(exifMeta);
  }

  // Already has a location name — skip unless this is a forced rescan
  if (photo.location_name && !force) return;

  // Prefer IPTC location block written by the camera / Lightroom — it's free
  // and avoids a Nominatim round-trip.
  if (iptcLoc) {
    await dbExec(
      db.update(photos).set(iptcLoc).where(eq(photos.id, photoId))
    );
    return;
  }

  // No GPS available at all — nothing to geocode.
  if (lat === null || lon === null) return;

  await geocodePhotoLocation(photoId, lat, lon);
}

// ---------- Photos ----------

/**
 * Check whether a photo with the given SHA-256 hash already exists for the
 * user. Used by the upload UI to detect duplicates client-side before
 * transferring the file.
 */
export async function checkPhotoHashLogic(
  userId: number,
  hash: string
): Promise<{ exists: boolean }> {
  const existing = await dbFirst<{ id: number }>(
    db.select({ id: photos.id })
      .from(photos)
      .where(and(eq(photos.user_id, userId), eq(photos.hash, hash)))
  );
  return { exists: !!existing };
}

export async function uploadPhotoStream(
  userId: number,
  stream: IncomingMessage,
  originalName: string,
  mimeType: string,
  isFavorite: boolean = false
): Promise<Photo> {
  if (!SUPPORTED_MIME_TYPES.has(mimeType.toLowerCase().split(";")[0].trim())) {
    throw new Error("UNSUPPORTED_FILE_TYPE");
  }

  const ext = normalizeImageExt(originalName, mimeType);
  const tempName = `upload_${Date.now()}_${crypto.randomBytes(6).toString("hex")}${ext}`;
  const tempPath = path.join(UPLOAD_TMP_DIR, tempName);

  const fileStream = fs.createWriteStream(tempPath);
  let size = 0;
  const hash = crypto.createHash('sha256');

  // We need to track the size and calculate hash while streaming
  stream.on('data', (chunk) => {
    size += chunk.length;
    hash.update(chunk);
  });

  await pipeline(stream, fileStream);
  const digest = hash.digest('hex');

  // Extraction of EXIF data (date + GPS) after the file is saved
  const exifMeta = await getExifMetadata(tempPath);

  // Check for duplicate for this user
  const existing = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.user_id, userId), eq(photos.hash, digest)))
  );

  if (existing) {
    // Delete the temporary file
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw new Error("PHOTO_ALREADY_EXISTS");
  }

  // Move the file into its final YYYY/YYYY-MM/YYYY-MM-DD_at_HH.MM.SS_NN.ext slot.
  const storageTs = pickStorageTimestamp(exifMeta.takenAt);
  const { absPath: filePath, relPath: filename } = await reserveStoragePath(storageTs, ext);
  await fs.promises.rename(tempPath, filePath);

  const descriptionValue = combineDescription(exifMeta);
  // Pre-fill location from IPTC when present, sparing us a Nominatim call.
  const iptcLoc = iptcLocationUpdate(exifMeta);
  const uploadKeywords = mergeRatingKeyword(exifMeta.keywords, exifMeta.rating);

  const row = await dbInsertReturning<typeof photos.$inferSelect>(
    db.insert(photos).values({
      user_id: userId,
      filename: filename,
      original_name: originalName,
      mime_type: mimeType,
      size: size,
      hash: digest,
      taken_at: exifMeta.takenAt,
      latitude: exifMeta.latitude,
      longitude: exifMeta.longitude,
      description: descriptionValue,
      keywords: uploadKeywords,
      ...(iptcLoc ?? {}),
    }).returning()
  );

  // Mark as favourite if the client flagged it (X-Is-Favorite header) or if XMP Rating >= 4
  if (isFavorite || (exifMeta.rating !== null && exifMeta.rating >= 4)) {
    await dbExec(
      db.insert(photoCuration)
        .values({ user_id: userId, photo_id: row!.id, status: "favorite" })
        .onConflictDoUpdate({
          target: [photoCuration.user_id, photoCuration.photo_id],
          set: { status: "favorite", updated_at: sql`NOW()` },
        })
    );
  }

  // Add to scan queue and wake workers — upload returns immediately
  enqueuePhotoScan(row!.id, userId).then(() => triggerWorkers()).catch(err => {
    console.error("Enqueue error:", err);
  });

  // Reverse-geocode GPS coordinates in background. Skipped when IPTC already
  // carries location info — Lightroom / camera apps often write that block on
  // export, and trusting it avoids a Nominatim round-trip per import.
  if (!iptcLoc && exifMeta.latitude !== null && exifMeta.longitude !== null) {
    geocodePhotoLocation(row!.id, exifMeta.latitude, exifMeta.longitude).catch(err => {
      console.error("Geocoding error:", err);
    });
  }

  return {
    id: row!.id,
    user_id: row!.user_id,
    filename: row!.filename,
    original_name: row!.original_name,
    mime_type: row!.mime_type,
    size: row!.size,
    hash: row!.hash ?? undefined,
    taken_at: row!.taken_at ?? undefined,
    created_at: row!.created_at ?? "",
    latitude: row!.latitude ?? undefined,
    longitude: row!.longitude ?? undefined,
    description: row!.description ?? undefined,
    keywords: row!.keywords ?? [],
  };
}

export async function uploadPhotoLogic(
  userId: number,
  file: { data: Buffer; name: string; mimeType: string }
): Promise<Photo> {
  if (!SUPPORTED_MIME_TYPES.has(file.mimeType.toLowerCase().split(";")[0].trim())) {
    throw new Error("UNSUPPORTED_FILE_TYPE");
  }

  const digest = crypto.createHash('sha256').update(file.data).digest('hex');

  // Check for duplicate for this user
  const existing2 = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.user_id, userId), eq(photos.hash, digest)))
  );

  if (existing2) {
    throw new Error("PHOTO_ALREADY_EXISTS");
  }

  const ext = normalizeImageExt(file.name, file.mimeType);
  const tempName = `upload_${Date.now()}_${crypto.randomBytes(6).toString("hex")}${ext}`;
  const tempPath = path.join(UPLOAD_TMP_DIR, tempName);

  fs.writeFileSync(tempPath, file.data);

  // Extraction of EXIF data (date + GPS)
  const exifMeta2 = await getExifMetadata(tempPath);

  // Move the file into its final YYYY/YYYY-MM/YYYY-MM-DD_at_HH.MM.SS_NN.ext slot.
  const storageTs2 = pickStorageTimestamp(exifMeta2.takenAt);
  const { absPath: filePath, relPath: filename } = await reserveStoragePath(storageTs2, ext);
  await fs.promises.rename(tempPath, filePath);

  const descriptionValue2 = combineDescription(exifMeta2);
  // Pre-fill location from IPTC when present, sparing us a Nominatim call.
  const iptcLoc2 = iptcLocationUpdate(exifMeta2);
  const uploadKeywords2 = mergeRatingKeyword(exifMeta2.keywords, exifMeta2.rating);

  const row2 = await dbInsertReturning<typeof photos.$inferSelect>(
    db.insert(photos).values({
      user_id: userId,
      filename: filename,
      original_name: file.name,
      mime_type: file.mimeType,
      size: file.data.length,
      hash: digest,
      taken_at: exifMeta2.takenAt,
      latitude: exifMeta2.latitude,
      longitude: exifMeta2.longitude,
      description: descriptionValue2,
      keywords: uploadKeywords2,
      ...(iptcLoc2 ?? {}),
    }).returning()
  );

  // Mark as favourite if XMP Rating >= 4
  if (exifMeta2.rating !== null && exifMeta2.rating >= 4) {
    await dbExec(
      db.insert(photoCuration)
        .values({ user_id: userId, photo_id: row2!.id, status: "favorite" })
        .onConflictDoUpdate({
          target: [photoCuration.user_id, photoCuration.photo_id],
          set: { status: "favorite", updated_at: sql`NOW()` },
        })
    );
  }

  // Add to scan queue and wake workers — upload returns immediately
  enqueuePhotoScan(row2!.id, userId).then(() => triggerWorkers()).catch(err => {
    console.error("Enqueue error:", err);
  });

  // Reverse-geocode GPS coordinates in background. Skipped when IPTC already
  // carries location info — see uploadPhotoStream for rationale.
  if (!iptcLoc2 && exifMeta2.latitude !== null && exifMeta2.longitude !== null) {
    geocodePhotoLocation(row2!.id, exifMeta2.latitude, exifMeta2.longitude).catch(err => {
      console.error("Geocoding error:", err);
    });
  }

  return {
    id: row2!.id,
    user_id: row2!.user_id,
    filename: row2!.filename,
    original_name: row2!.original_name,
    mime_type: row2!.mime_type,
    size: row2!.size,
    hash: row2!.hash ?? undefined,
    taken_at: row2!.taken_at ?? undefined,
    created_at: row2!.created_at ?? "",
    latitude: row2!.latitude ?? undefined,
    longitude: row2!.longitude ?? undefined,
    description: row2!.description ?? undefined,
    keywords: row2!.keywords ?? [],
  };
}

export async function listPhotosLogic(
  userId: number,
  filter: PhotoFilterParams = {}
): Promise<ListPhotosResponse> {
  const filterConds = buildPhotoFilterConditions(userId, filter);
  const whereClause = and(eq(photos.user_id, userId), ...filterConds);

  const rows = await dbAll<{
    id: number; user_id: number; filename: string; original_name: string;
    mime_type: string; size: number; hash: string | null; taken_at: string | null;
    created_at: string | null; curation_status: string | null;
    latitude: number | null; longitude: number | null;
    location_name: string | null; location_city: string | null; location_country: string | null;
    location_short: string | null;
    ai_quality_score: number | null;
    ai_quality_details: Record<string, number> | null;
    auto_crop: { x: number; y: number } | null;
    description: string | null;
    keywords: string[] | null;
  }>(
    db
      .select({
        id: photos.id,
        user_id: photos.user_id,
        filename: photos.filename,
        original_name: photos.original_name,
        mime_type: photos.mime_type,
        size: photos.size,
        hash: photos.hash,
        taken_at: photos.taken_at,
        created_at: photos.created_at,
        curation_status: photoCuration.status,
        latitude: photos.latitude,
        longitude: photos.longitude,
        location_name: photos.location_name,
        location_city: photos.location_city,
        location_country: photos.location_country,
        location_short: photos.location_short,
        ai_quality_score: photos.ai_quality_score,
        ai_quality_details: photos.ai_quality_details,
        auto_crop: photos.auto_crop,
        description: photos.description,
        keywords: photos.keywords,
      })
      .from(photos)
      .leftJoin(
        photoCuration,
        and(eq(photos.id, photoCuration.photo_id), eq(photoCuration.user_id, userId))
      )
      .where(whereClause)
      .orderBy(sql`${photoDateOrder} DESC`)
  );

  return {
    photos: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      filename: r.filename,
      original_name: r.original_name,
      mime_type: r.mime_type,
      size: r.size,
      hash: r.hash ?? undefined,
      taken_at: r.taken_at ?? undefined,
      created_at: r.created_at ?? "",
      curation_status: (r.curation_status as CurationStatus) ?? "visible",
      latitude: r.latitude ?? undefined,
      longitude: r.longitude ?? undefined,
      location_name: r.location_name ?? undefined,
      location_city: r.location_city ?? undefined,
      location_country: r.location_country ?? undefined,
      location_short: r.location_short ?? undefined,
      ai_quality_score: r.ai_quality_score ?? undefined,
      ai_quality_details: r.ai_quality_details ?? undefined,
      auto_crop: r.auto_crop ?? undefined,
      description: r.description ?? undefined,
      keywords: r.keywords ?? [],
    })),
  };
}

/**
 * Lightweight gallery index: returns only the columns required to render the
 * grid (id, filename, dates, curation_status, auto_crop) and group photos by
 * year/month. Heavy fields (location_*, ai_quality_*, description, hash, GPS)
 * are loaded on demand via getPhotoDetailsBatchLogic.
 *
 * Designed to make the initial photo list load fast even with many thousands
 * of photos.
 */

/**
 * Cheap user-scoped snapshot used for the /photos/index ETag.
 *
 * Returns:
 *   maxUpdatedAt – MAX(photos.updated_at) across the user's photos. Bumped
 *                  by DB triggers (see migration 0034) on every photo
 *                  mutation AND on every per-user curation mutation.
 *   count        – COUNT(*) across the user's photos. Catches deletes
 *                  that do not move the MAX (e.g., an old photo is
 *                  removed while a newer one still holds the max).
 *
 * The query is a single aggregated SELECT and uses the
 * (user_id, updated_at DESC) index, so it is effectively O(1) on large
 * libraries. When a user has zero photos, maxUpdatedAt is "0" so the
 * resulting ETag is still well-defined.
 */
export async function getPhotoIndexFingerprint(
  userId: number,
): Promise<{ maxUpdatedAt: string; count: number }> {
  const row = await dbFirst<{ max_u: string | null; c: number }>(
    db
      .select({
        max_u: sql<string | null>`MAX(${photos.updated_at})`,
        c: sql<number>`COUNT(*)::int`,
      })
      .from(photos)
      .where(eq(photos.user_id, userId)),
  );
  return {
    maxUpdatedAt: row?.max_u ?? "0",
    count: row?.c ?? 0,
  };
}

/**
 * Build the ETag value for a /photos/index response given the user's
 * fingerprint and the serialized filter+pagination string. Wrapped in
 * quotes to conform with RFC 7232; the "W/" weak prefix is intentionally
 * NOT used because the body really is byte-identical for a given key.
 */
export function photoIndexEtag(
  userId: number,
  fp: { maxUpdatedAt: string; count: number },
  serializedFilter: string,
): string {
  const hash = crypto
    .createHash("md5")
    .update(`${userId}|${fp.maxUpdatedAt}|${fp.count}|${serializedFilter}`)
    .digest("hex");
  return `"${hash}"`;
}

export async function listPhotoIndexLogic(
  userId: number,
  filter: PhotoFilterParams = {},
  pagination: { limit?: number; offset?: number } = {}
): Promise<ListPhotoIndexResponse> {
  const filterConds = buildPhotoFilterConditions(userId, filter);
  const whereClause = and(eq(photos.user_id, userId), ...filterConds);

  // Only run the COUNT(*) when the caller requested a page — otherwise the
  // full-list path keeps its original cost profile (no extra query).
  let total: number | undefined;
  if (pagination.limit !== undefined) {
    const countRow = await dbFirst<{ c: number }>(
      db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(photos)
        .leftJoin(
          photoCuration,
          and(eq(photos.id, photoCuration.photo_id), eq(photoCuration.user_id, userId))
        )
        .where(whereClause)
    );
    total = countRow?.c ?? 0;
  }

  let query = db
    .select({
      id: photos.id,
      user_id: photos.user_id,
      filename: photos.filename,
      original_name: photos.original_name,
      mime_type: photos.mime_type,
      size: photos.size,
      taken_at: photos.taken_at,
      created_at: photos.created_at,
      curation_status: photoCuration.status,
      auto_crop: photos.auto_crop,
    })
    .from(photos)
    .leftJoin(
      photoCuration,
      and(eq(photos.id, photoCuration.photo_id), eq(photoCuration.user_id, userId))
    )
    .where(whereClause)
    .orderBy(sql`${photoDateOrder} DESC`)
    .$dynamic();

  if (pagination.limit !== undefined) {
    query = query.limit(pagination.limit);
  }
  if (pagination.offset !== undefined && pagination.offset > 0) {
    query = query.offset(pagination.offset);
  }

  const rows = await dbAll<{
    id: number; user_id: number; filename: string; original_name: string;
    mime_type: string; size: number;
    taken_at: string | null; created_at: string | null;
    curation_status: string | null;
    auto_crop: { x: number; y: number } | null;
  }>(query);

  const result: PhotoIndexEntry[] = rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    filename: r.filename,
    original_name: r.original_name,
    mime_type: r.mime_type,
    size: r.size,
    taken_at: r.taken_at ?? undefined,
    created_at: r.created_at ?? "",
    curation_status: (r.curation_status as CurationStatus) ?? "visible",
    auto_crop: r.auto_crop ?? undefined,
  }));

  return total !== undefined
    ? { photos: result, total }
    : { photos: result };
}

/**
 * Returns full PhotoWithCuration records for a list of photo IDs that belong
 * to the given user. Used by the frontend to progressively hydrate the photo
 * index with the heavy fields needed for the detail sidebar/fullscreen view.
 *
 * IDs not owned by the user are silently skipped (no leak of existence).
 */
export async function getPhotoDetailsBatchLogic(
  userId: number,
  ids: number[]
): Promise<PhotoDetailsBatchResponse> {
  if (ids.length === 0) return { photos: [] };

  const rows = await dbAll<{
    id: number; user_id: number; filename: string; original_name: string;
    mime_type: string; size: number; hash: string | null; taken_at: string | null;
    created_at: string | null; curation_status: string | null;
    latitude: number | null; longitude: number | null;
    location_name: string | null; location_city: string | null; location_country: string | null;
    location_short: string | null;
    ai_quality_score: number | null;
    ai_quality_details: Record<string, number> | null;
    auto_crop: { x: number; y: number } | null;
    description: string | null;
    keywords: string[] | null;
  }>(
    db
      .select({
        id: photos.id,
        user_id: photos.user_id,
        filename: photos.filename,
        original_name: photos.original_name,
        mime_type: photos.mime_type,
        size: photos.size,
        hash: photos.hash,
        taken_at: photos.taken_at,
        created_at: photos.created_at,
        curation_status: photoCuration.status,
        latitude: photos.latitude,
        longitude: photos.longitude,
        location_name: photos.location_name,
        location_city: photos.location_city,
        location_country: photos.location_country,
        location_short: photos.location_short,
        ai_quality_score: photos.ai_quality_score,
        ai_quality_details: photos.ai_quality_details,
        auto_crop: photos.auto_crop,
        description: photos.description,
        keywords: photos.keywords,
      })
      .from(photos)
      .leftJoin(
        photoCuration,
        and(eq(photos.id, photoCuration.photo_id), eq(photoCuration.user_id, userId))
      )
      .where(and(eq(photos.user_id, userId), inArray(photos.id, ids)))
  );

  return {
    photos: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      filename: r.filename,
      original_name: r.original_name,
      mime_type: r.mime_type,
      size: r.size,
      hash: r.hash ?? undefined,
      taken_at: r.taken_at ?? undefined,
      created_at: r.created_at ?? "",
      curation_status: (r.curation_status as CurationStatus) ?? "visible",
      latitude: r.latitude ?? undefined,
      longitude: r.longitude ?? undefined,
      location_name: r.location_name ?? undefined,
      location_city: r.location_city ?? undefined,
      location_country: r.location_country ?? undefined,
      location_short: r.location_short ?? undefined,
      ai_quality_score: r.ai_quality_score ?? undefined,
      ai_quality_details: r.ai_quality_details ?? undefined,
      auto_crop: r.auto_crop ?? undefined,
      description: r.description ?? undefined,
      keywords: r.keywords ?? [],
    })),
  };
}

export async function deletePhotoLogic(userId: number, photoId: number): Promise<DeleteResponse> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );

  if (!photo) {
    throw new Error("Photo not found or unauthorized");
  }

  // Soft-delete: set curation status to 'hidden'
  await dbExec(
    db.insert(photoCuration)
      .values({ user_id: userId, photo_id: photoId, status: "hidden" })
      .onConflictDoUpdate({
        target: [photoCuration.user_id, photoCuration.photo_id],
        set: { status: "hidden", updated_at: sql`NOW()` },
      })
  );

  return { success: true, message: "Photo hidden" };
}

/** Returns the 2-char hex shard subdirectory for a thumbnail baseName (MD5-based, 256 buckets). */
export function thumbnailShardPath(baseName: string): string {
  const shard = crypto.createHash('md5').update(baseName).digest('hex').slice(0, 2);
  return path.join(THUMBNAIL_DIR, shard);
}

/** Delete all cached thumbnail variants for a given photo filename. */
async function deleteCachedThumbnails(filename: string): Promise<void> {
  const baseName = path.basename(filename, path.extname(filename));
  // Library photos use a hashed cache key to avoid basename collisions across
  // libraries — see getPhotoFile for the matching cache-write logic.
  const cacheBase = filename.startsWith("__library/")
    ? `${baseName}_${crypto.createHash("md5").update(filename).digest("hex").slice(0, 8)}`
    : baseName;
  const prefix = `${cacheBase}_`;
  const shardPath = thumbnailShardPath(cacheBase);
  try {
    const entries = await fs.promises.readdir(shardPath);
    await Promise.all(
      entries
        .filter(f => f.startsWith(prefix) && f.endsWith('.jpg'))
        .map(f => fs.promises.unlink(path.join(shardPath, f)).catch(() => {}))
    );
  } catch {
    // shard dir missing or unreadable — nothing to clean up
  }
}

export async function hardDeletePhotoLogic(userId: number, photoId: number): Promise<DeleteResponse> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );

  if (!photo) {
    throw new Error("Photo not found or unauthorized");
  }

  // For `link`-imported photos the file lives outside our storage and the
  // library is the source of truth — only drop the DB row + thumbnails. The
  // unlink watcher does the same when the source file disappears externally.
  if (!photo.external_path) {
    const filePath = path.join(UPLOAD_DIR, photo.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
  await deleteCachedThumbnails(photo.filename);

  // Hard delete from DB (cascades to curation, faces, album_photos, group_members)
  await dbExec(db.delete(photos).where(eq(photos.id, photoId)));

  return { success: true, message: "Photo permanently deleted" };
}

export async function updatePhotoCurationLogic(
  userId: number,
  photoId: number,
  status: CurationStatus
): Promise<{ success: boolean }> {
  // Fetch the photo record regardless of ownership. Users who do not own the
  // photo are allowed to change their OWN curation status for it if the photo
  // appears in an album that has been shared with them.
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(eq(photos.id, photoId))
  );

  if (!photo) {
    throw new Error("Photo not found");
  }

  // If the requester is not the owner, allow the action only when the photo
  // is part of an album that has been shared with the requester (any access level).
  // Curation (favorites/hiding) is user-specific and does not affect other users,
  // so both "read" and "write" shares are permitted.
  if (photo.user_id !== userId) {
    const shared = await dbFirst(
      db
        .select({ album_id: albumPhotos.album_id })
        .from(albumPhotos)
        .innerJoin(albumShares, eq(albumShares.album_id, albumPhotos.album_id))
        .where(and(
          eq(albumPhotos.photo_id, photoId),
          eq(albumShares.user_id, userId)
        ))
    );
    if (!shared) {
      throw new Error("Photo not found or unauthorized");
    }
  }

  // Read the previous status so we can detect favourite transitions for
  // the XMP write-back below.
  const prev = await dbFirst<{ status: CurationStatus }>(
    db.select({ status: photoCuration.status })
      .from(photoCuration)
      .where(and(eq(photoCuration.user_id, userId), eq(photoCuration.photo_id, photoId)))
  );
  const prevStatus: CurationStatus = prev?.status ?? "visible";

  if (status === "visible") {
    // Remove the curation row entirely (visible is the default)
    await dbExec(
      db.delete(photoCuration)
        .where(and(eq(photoCuration.user_id, userId), eq(photoCuration.photo_id, photoId)))
    );
  } else {
    await dbExec(
      db.insert(photoCuration)
        .values({ user_id: userId, photo_id: photoId, status })
        .onConflictDoUpdate({
          target: [photoCuration.user_id, photoCuration.photo_id],
          set: { status, updated_at: sql`NOW()` },
        })
    );
  }

  // Sync the favourite flag into the file's XMP rating when the requester is
  // the owner — favourites are per-user but the file is shared. Only writes
  // on an actual transition into or out of "favorite".
  if (photo.user_id === userId && prevStatus !== status) {
    if (status === "favorite") {
      await writeFavoriteRatingXmp(getPhotoDiskPath(photo), true);
    } else if (prevStatus === "favorite") {
      await writeFavoriteRatingXmp(getPhotoDiskPath(photo), false);
    }
  }

  // After hiding a photo, check if it belongs to an unreviewed group where all
  // remaining members are now hidden. If so, mark the group as reviewed.
  if (status === "hidden") {
    const memberOfGroups = await dbAll<{ group_id: number }>(
      db.select({ group_id: photoGroupMembers.group_id })
        .from(photoGroupMembers)
        .innerJoin(photoGroups, eq(photoGroups.id, photoGroupMembers.group_id))
        .where(and(
          eq(photoGroupMembers.photo_id, photoId),
          eq(photoGroups.user_id, userId),
          isNull(photoGroups.reviewed_at)
        ))
    );

    for (const { group_id } of memberOfGroups) {
      // Count members that are NOT hidden for this user
      const visibleMembers = await dbAll<{ photo_id: number }>(
        db.select({ photo_id: photoGroupMembers.photo_id })
          .from(photoGroupMembers)
          .leftJoin(
            photoCuration,
            and(
              eq(photoCuration.photo_id, photoGroupMembers.photo_id),
              eq(photoCuration.user_id, userId)
            )
          )
          .where(and(
            eq(photoGroupMembers.group_id, group_id),
            or(isNull(photoCuration.status), sql`${photoCuration.status} != 'hidden'`)
          ))
      );

      if (visibleMembers.length === 0) {
        // All members are hidden – mark group as reviewed
        await dbExec(
          db.update(photoGroups)
            .set({ reviewed_at: new Date().toISOString() })
            .where(eq(photoGroups.id, group_id))
        );
      }
    }
  }

  return { success: true };
}

/**
 * Batch-favorite multiple photos within an album context.
 * Verifies album access and that all photos belong to the album.
 */
export async function batchFavoritePhotosLogic(
  userId: number,
  albumId: number,
  photoIds: number[]
): Promise<{ success: boolean; favorited: number }> {
  if (photoIds.length === 0) return { success: true, favorited: 0 };

  // Verify album access
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, albumId))
  );
  if (!album) throw new Error("Album not found");

  const isOwner = album.user_id === userId;
  if (!isOwner) {
    const share = await dbFirst<typeof albumShares.$inferSelect>(
      db.select().from(albumShares).where(and(eq(albumShares.album_id, albumId), eq(albumShares.user_id, userId)))
    );
    if (!share) throw new Error("Unauthorized access to album");
  }

  // Verify all photos belong to the album
  const albumPhotoRows = await dbAll<{ photo_id: number }>(
    db.select({ photo_id: albumPhotos.photo_id })
      .from(albumPhotos)
      .where(and(eq(albumPhotos.album_id, albumId), inArray(albumPhotos.photo_id, photoIds)))
  );
  const validPhotoIds = albumPhotoRows.map(r => r.photo_id);

  if (validPhotoIds.length === 0) return { success: true, favorited: 0 };

  // Batch upsert curation rows to 'favorite'
  for (const photoId of validPhotoIds) {
    await dbExec(
      db.insert(photoCuration)
        .values({ user_id: userId, photo_id: photoId, status: "favorite" })
        .onConflictDoUpdate({
          target: [photoCuration.user_id, photoCuration.photo_id],
          set: { status: "favorite", updated_at: sql`NOW()` },
        })
    );
  }

  // Write the favourite flag back to XMP for photos owned by the requester.
  // Shared photos stay read-only on disk — favourites are per-user but the
  // file is not.
  const ownedPhotos = await dbAll<{ id: number; filename: string; external_path: string | null }>(
    db.select({
      id: photos.id,
      filename: photos.filename,
      external_path: photos.external_path,
    })
    .from(photos)
    .where(and(eq(photos.user_id, userId), inArray(photos.id, validPhotoIds)))
  );
  for (const p of ownedPhotos) {
    await writeFavoriteRatingXmp(getPhotoDiskPath(p), true);
  }

  return { success: true, favorited: validPhotoIds.length };
}

export async function getPhotosToRefreshMetadataLogic(userId: number): Promise<{ ids: number[] }> {
  const rows = await dbAll<{ id: number }>(
    db.select({ id: photos.id }).from(photos).where(eq(photos.user_id, userId))
  );
  return { ids: rows.map((r) => r.id) };
}

export async function refreshPhotoMetadataLogic(userId: number, photoId: number): Promise<{ success: boolean; taken_at?: string }> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );

  if (!photo) {
    throw new Error("Photo not found or unauthorized");
  }

  const filePath = getPhotoDiskPath(photo);
  if (!fs.existsSync(filePath)) {
    throw new Error("File not found on disk");
  }

  const exifMeta = await getExifMetadata(filePath);

  // Always update, even if takenAt is null (to sync with current logic if it was different before).
  // Description falls back to the IPTC Headline when no caption was written.
  // Keywords sync is one-way: we trust what's on disk.
  const iptcLoc = iptcLocationUpdate(exifMeta);
  await dbExec(db.update(photos).set({
    taken_at: exifMeta.takenAt,
    description: combineDescription(exifMeta) ?? photo.description,
    keywords: exifMeta.keywords,
    ...(iptcLoc ?? {}),
  }).where(eq(photos.id, photoId)));

  return { success: true, taken_at: exifMeta.takenAt ?? undefined };
}

export async function updatePhotoDateLogic(
  userId: number,
  photoId: number,
  takenAt: string
): Promise<{ success: boolean; taken_at: string }> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );

  if (!photo) {
    throw new Error("Photo not found or unauthorized");
  }

  const filePath = getPhotoDiskPath(photo);
  if (!fs.existsSync(filePath)) {
    throw new Error("File not found on disk");
  }

  const parsedDate = new Date(takenAt);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error("Invalid taken_at date");
  }

  // 1. Update database
  await dbExec(db.update(photos).set({ taken_at: takenAt }).where(eq(photos.id, photoId)));

  // 2. Update file metadata
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!EXIF_WRITABLE_EXTENSIONS.has(ext)) {
      return { success: true, taken_at: takenAt };
    }

    const year = parsedDate.getFullYear();
    const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
    const day = String(parsedDate.getDate()).padStart(2, '0');
    const hours = String(parsedDate.getHours()).padStart(2, '0');
    const minutes = String(parsedDate.getMinutes()).padStart(2, '0');
    const seconds = String(parsedDate.getSeconds()).padStart(2, '0');
    const formattedDate = `${year}:${month}:${day} ${hours}:${minutes}:${seconds}`;
    const iptcDate = `${year}:${month}:${day}`;
    const iptcTime = `${hours}:${minutes}:${seconds}`;

    // Write to multiple tags to ensure compatibility across EXIF, IPTC and XMP.
    await Promise.race([
      exiftool.write(filePath, {
        // EXIF
        DateTimeOriginal: formattedDate,
        CreateDate: formattedDate,
        ModifyDate: formattedDate,
        // IPTC IIM
        DateCreated: iptcDate,
        TimeCreated: iptcTime,
        DigitalCreationDate: iptcDate,
        DigitalCreationTime: iptcTime,
      }, ["-overwrite_original"]),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`EXIF_WRITE_TIMEOUT after ${EXIF_WRITE_TIMEOUT_MS}ms`)), EXIF_WRITE_TIMEOUT_MS);
      })
    ]);
  } catch (err) {
    console.error("Error updating EXIF data with exiftool:", err);
    // Don't throw error if DB update succeeded, but log it
  }

  return { success: true, taken_at: takenAt };
}

export async function updatePhotoDescriptionLogic(
  userId: number,
  photoId: number,
  description: string | null
): Promise<{ success: boolean; description: string | null }> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );

  if (!photo) {
    throw new Error("Photo not found or unauthorized");
  }

  const trimmed = description?.trim() || null;

  // 1. Update database
  await dbExec(db.update(photos).set({ description: trimmed }).where(eq(photos.id, photoId)));

  // 2. Write description into EXIF, IPTC and XMP. Keeping the three kept in
  //    sync makes the description survive third-party tooling that only reads
  //    one of the three (e.g. Windows Explorer reads XMP, Lightroom reads IPTC,
  //    legacy viewers read EXIF ImageDescription).
  try {
    const filePath = getPhotoDiskPath(photo);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      if (EXIF_WRITABLE_EXTENSIONS.has(ext)) {
        const value = trimmed ?? "";
        await Promise.race([
          exiftool.write(filePath, {
            // EXIF
            ImageDescription: value,
            // XMP (dc:description). exiftool-vendored's `Description` write
            // shortcut targets XMP:Description.
            "Description": value,
            // IPTC Caption-Abstract
            "Caption-Abstract": value,
          }, ["-overwrite_original"]),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`EXIF_WRITE_TIMEOUT after ${EXIF_WRITE_TIMEOUT_MS}ms`)), EXIF_WRITE_TIMEOUT_MS);
          })
        ]);
      }
    }
  } catch (err) {
    console.error("Error writing description to EXIF:", err);
  }

  return { success: true, description: trimmed };
}

/**
 * Write the favourite flag back to the photo file as `xmp:Rating`.
 *
 * Mapping mirrors the import direction (see `getExifMetadata` /
 * `favorite_rating_threshold`): a favourite is persisted as rating `5`, an
 * un-favourite as `0` (Adobe's "not rated" convention). This means toggling
 * favourites round-trips through XMP and stays in sync with third-party tools
 * (Lightroom, digiKam, Finder, Windows Explorer, iOS Photos sync).
 *
 * Callers are expected to gate on ownership — favourites are per-user but the
 * file is shared, so only the photo owner's changes propagate to disk.
 */
async function writeFavoriteRatingXmp(filePath: string, isFavorite: boolean): Promise<void> {
  if (!fs.existsSync(filePath)) return;
  const ext = path.extname(filePath).toLowerCase();
  if (!EXIF_WRITABLE_EXTENSIONS.has(ext)) return;
  try {
    await Promise.race([
      exiftool.write(filePath, {
        Rating: isFavorite ? 5 : 0,
      }, ["-overwrite_original"]),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`EXIF_WRITE_TIMEOUT after ${EXIF_WRITE_TIMEOUT_MS}ms`)), EXIF_WRITE_TIMEOUT_MS);
      })
    ]);
  } catch (err) {
    console.error("Error writing favorite rating to XMP:", err);
  }
}

export function getPhotoFileLogic(filename: string): { data: string; mimeType: string } {
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error("File not found");
  }
  const data = fs.readFileSync(filePath).toString('base64');
  const ext = path.extname(filename).toLowerCase();
  let mimeType = "application/octet-stream";
  if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";
  else if (ext === ".png") mimeType = "image/png";
  else if (ext === ".gif") mimeType = "image/gif";
  else if (ext === ".webp") mimeType = "image/webp";

  return { data, mimeType };
}

export async function convertHeicToJpeg(filePath: string): Promise<Buffer> {
  // sharp's bundled libvips lacks HEIC decode support; use heic-convert
  // (libheif via WASM) instead. Decoded buffers are held in a small LRU
  // keyed by (filePath, mtimeMs) so back-to-back pipelines (quality,
  // embedding, thumbnail prewarm, on-demand /photos/file) that touch the
  // same HEIC pay the decode cost at most once.
  let mtimeMs = 0;
  try {
    const st = await fs.promises.stat(filePath);
    mtimeMs = st.mtimeMs;
    const cached = getHeicDecodeCached(filePath, mtimeMs);
    if (cached) return cached;
  } catch {
    // stat failed — fall through, readFile below will report the real error
  }

  const inputBuffer = await fs.promises.readFile(filePath);
  const outputBuffer = await heicConvert({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 });
  const decoded = Buffer.from(outputBuffer);
  if (mtimeMs > 0) setHeicDecodeCached(filePath, mtimeMs, decoded);
  return decoded;
}

/**
 * Resize an image buffer to the given target width, preserving aspect ratio.
 * Always outputs JPEG. If the image is already smaller than targetWidth, it is
 * returned as-is (no upscaling). Returns a JPEG buffer.
 */
export async function resizeImage(imageBuffer: Buffer, targetWidth: number): Promise<Buffer> {
  // Route through the sharp worker pool when available so the main thread
  // never blocks on libvips decode/encode. Falls back to an in-process call
  // when the pool is disabled (see resizeImageInPool implementation).
  return resizeImageInPool(imageBuffer, targetWidth);
}

/**
 * Build the thumbnail cache filename for a given photo filename + target
 * width. Mirrors the logic in photo.ts:getPhotoFile so a cache entry created
 * here is a hit for the /photos/file endpoint.
 */
export function thumbnailCacheKey(filename: string, targetWidth: number): {
  shardPath: string;
  cachePath: string;
} {
  const baseName = path.basename(filename, path.extname(filename));
  const isLibrary = filename.startsWith("__library/");
  const cacheBase = isLibrary
    ? `${baseName}_${crypto.createHash("md5").update(filename).digest("hex").slice(0, 8)}`
    : baseName;
  const shardPath = thumbnailShardPath(cacheBase);
  const cachePath = path.join(shardPath, `${cacheBase}_${targetWidth}w.jpg`);
  return { shardPath, cachePath };
}

/**
 * Pre-generate thumbnails for a photo at the widths listed in
 * THUMBNAIL_PREWARM_WIDTHS. Runs on a background worker so the /photos/file
 * endpoint always hits the on-disk cache and never blocks on sharp() or
 * heic-convert on the request path.
 *
 * Skips widths whose cache file already exists. Any IO/decode errors are
 * logged and do not fail the job — a missing thumbnail simply means the
 * next request re-generates it on-demand.
 */
export async function indexPhotoThumbnails(photoId: number): Promise<void> {
  if (!ENABLE_THUMBNAIL_PREWARM) return;
  if (THUMBNAIL_PREWARM_WIDTHS.length === 0) return;

  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(eq(photos.id, photoId))
  );
  if (!photo) return;

  const filePath = getPhotoDiskPath(photo);
  try {
    await fs.promises.access(filePath);
  } catch {
    return; // source file missing — nothing to prewarm
  }

  // Figure out which widths still need to be generated. `fs.promises.access`
  // with F_OK is the cheapest existence check (no fd open).
  const targets: number[] = [];
  for (const width of THUMBNAIL_PREWARM_WIDTHS) {
    const { cachePath } = thumbnailCacheKey(photo.filename, width);
    try {
      await fs.promises.access(cachePath);
      // already cached — skip
    } catch {
      targets.push(width);
    }
  }
  if (targets.length === 0) return;

  // Decode the source once and re-use the buffer for every width. HEIC files
  // need the WASM decoder; everything else goes straight through libvips.
  const ext = path.extname(photo.filename).toLowerCase();
  let sourceBuffer: Buffer;
  try {
    if (ext === ".heic" || ext === ".heif") {
      sourceBuffer = await convertHeicToJpeg(filePath);
    } else {
      sourceBuffer = await fs.promises.readFile(filePath);
    }
  } catch (err) {
    console.error(`[thumbnail] source read/convert failed for photo ${photoId}:`, err);
    return;
  }

  // Generate widths sequentially to keep peak memory + CPU low. Parallelising
  // across widths on a single worker would fight with other scan workers
  // for the libuv thread pool and is not worth the complexity.
  for (const width of targets) {
    const { shardPath, cachePath } = thumbnailCacheKey(photo.filename, width);
    try {
      const resized = await resizeImage(sourceBuffer, width);
      await fs.promises.mkdir(shardPath, { recursive: true });
      await fs.promises.writeFile(cachePath, resized);
    } catch (err) {
      console.error(`[thumbnail] generate w=${width} for photo ${photoId} failed:`, err);
    }
  }
}

// ---------- Albums ----------

async function getAlbumStats(albumId: number, userId?: number): Promise<{ newest_photo_at?: string, oldest_photo_at?: string, photo_count: number, newest_photo_filename?: string }> {
  const hiddenFilter = userId
    ? sql`AND NOT EXISTS (SELECT 1 FROM ${photoCuration} WHERE ${photoCuration.photo_id} = ${albumPhotos.photo_id} AND ${photoCuration.user_id} = ${userId} AND ${photoCuration.status} = 'hidden')`
    : sql``;

  const stats = await dbFirst<any>(
    db.select({
      newest_photo_at: sql<string>`MAX(COALESCE(${photos.taken_at}, ${photos.created_at}))`,
      oldest_photo_at: sql<string>`MIN(COALESCE(${photos.taken_at}, ${photos.created_at}))`,
      photo_count: sql<number>`COUNT(*)`,
    })
    .from(albumPhotos)
    .innerJoin(photos, eq(albumPhotos.photo_id, photos.id))
    .where(sql`${albumPhotos.album_id} = ${albumId} ${hiddenFilter}`)
  );

  let newestFilename: string | undefined = undefined;
  if (stats && Number(stats.photo_count) > 0) {
    const newest = await dbFirst<any>(
      db.select({ filename: photos.filename })
      .from(albumPhotos)
      .innerJoin(photos, eq(albumPhotos.photo_id, photos.id))
      .where(sql`${albumPhotos.album_id} = ${albumId} ${hiddenFilter}`)
      .orderBy(desc(sql`COALESCE(${photos.taken_at}, ${photos.created_at})`))
      .limit(1)
    );
    newestFilename = newest?.filename;
  }

  return {
    newest_photo_at: stats?.newest_photo_at ?? undefined,
    oldest_photo_at: stats?.oldest_photo_at ?? undefined,
    photo_count: Number(stats?.photo_count || 0),
    newest_photo_filename: newestFilename
  };
}

export async function createAlbumLogic(userId: number, req: CreateAlbumRequest): Promise<Album> {
  const row = await dbInsertReturning<typeof albums.$inferSelect>(
    db.insert(albums).values({ user_id: userId, name: req.name, description: req.description ?? null, display_mode: req.displayMode ?? "grid" }).returning()
  );

  return {
    id: row!.id,
    user_id: row!.user_id,
    name: row!.name,
    description: row!.description ?? undefined,
    cover_photo_id: row!.cover_photo_id ?? undefined,
    cover_filename: undefined,
    display_mode: (row!.display_mode as "grid" | "map") ?? "grid",
    photo_count: 0,
    created_at: row!.created_at ?? "",
    updated_at: row!.updated_at ?? "",
  };
}

export async function listAlbumsLogic(userId: number): Promise<ListAlbumsResponse> {
  // Albums owned by user OR shared with user
  const sharedAlbumIdsRows = await dbAll<{ album_id: number }>(
    db.select({ album_id: albumShares.album_id }).from(albumShares).where(eq(albumShares.user_id, userId))
  );
  const sharedAlbumIds = sharedAlbumIdsRows.map((s) => s.album_id);

  const rows = await dbAll<any>(
    db
      .select({
        id: albums.id,
        user_id: albums.user_id,
        name: albums.name,
        description: albums.description,
        event_name: albums.event_name,
        cover_photo_id: albums.cover_photo_id,
        display_mode: albums.display_mode,
        created_at: albums.created_at,
        updated_at: albums.updated_at,
        is_shared: sql<boolean>`EXISTS (
          SELECT 1 FROM ${albumShares}
          WHERE ${albumShares.album_id} = ${albums.id}
        )`,
        cover_filename: sql<string>`COALESCE(
          ${photos.filename},
          (
            SELECT p_cover.filename
            FROM ${albumPhotos} ap_cover
            JOIN ${photos} p_cover ON ap_cover.photo_id = p_cover.id
            WHERE ap_cover.album_id = ${albums.id}
              AND NOT EXISTS (SELECT 1 FROM ${photoCuration} pc WHERE pc.photo_id = ap_cover.photo_id AND pc.user_id = ${userId} AND pc.status = 'hidden')
            ORDER BY COALESCE(p_cover.taken_at, p_cover.created_at) DESC
            LIMIT 1
          )
        )`,
        newest_photo_at: sql<string>`(
          SELECT MAX(COALESCE(p_new.taken_at, p_new.created_at))
          FROM ${albumPhotos} ap_new
          JOIN ${photos} p_new ON ap_new.photo_id = p_new.id
          WHERE ap_new.album_id = ${albums.id}
            AND NOT EXISTS (SELECT 1 FROM ${photoCuration} pc WHERE pc.photo_id = ap_new.photo_id AND pc.user_id = ${userId} AND pc.status = 'hidden')
        )`,
        oldest_photo_at: sql<string>`(
          SELECT MIN(COALESCE(p_old.taken_at, p_old.created_at))
          FROM ${albumPhotos} ap_old
          JOIN ${photos} p_old ON ap_old.photo_id = p_old.id
          WHERE ap_old.album_id = ${albums.id}
            AND NOT EXISTS (SELECT 1 FROM ${photoCuration} pc WHERE pc.photo_id = ap_old.photo_id AND pc.user_id = ${userId} AND pc.status = 'hidden')
        )`,
        photo_count: sql<number>`(
          SELECT COUNT(*)
          FROM ${albumPhotos} ap_cnt
          WHERE ap_cnt.album_id = ${albums.id}
            AND NOT EXISTS (SELECT 1 FROM ${photoCuration} pc WHERE pc.photo_id = ap_cnt.photo_id AND pc.user_id = ${userId} AND pc.status = 'hidden')
        )`,
      })
      .from(albums)
      .leftJoin(photos, eq(photos.id, albums.cover_photo_id))
      .where(or(eq(albums.user_id, userId), sharedAlbumIds.length > 0 ? inArray(albums.id, sharedAlbumIds) : undefined))
  );

  return {
    albums: rows.map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      name: r.name,
      description: r.description ?? undefined,
      cover_photo_id: r.cover_photo_id ?? undefined,
      cover_filename: r.cover_filename ?? undefined,
      display_mode: (r.display_mode as "grid" | "map") ?? "grid",
      newest_photo_at: r.newest_photo_at ?? undefined,
      oldest_photo_at: r.oldest_photo_at ?? undefined,
      photo_count: Number(r.photo_count || 0),
      is_shared: !!r.is_shared,
      created_at: r.created_at ?? "",
      updated_at: r.updated_at ?? "",
    })),
  };
}

// ── View Presets ─────────────────────────────────────────────────────────────

const VIEW_PRESETS: Record<string, ViewConfig> = {
  all:                { hideFilter: "mine",      favFilter: "all" },
  favorites:          { hideFilter: "mine",      favFilter: "mine" },
  consensus:          { hideFilter: "consensus", favFilter: "consensus", hideConsensusMin: 1, favConsensusMin: 2 },
  "others-favorites": { hideFilter: "mine",      favFilter: "others-not-mine" },
};

/** Resolve effective ViewConfig from active_view preset or custom view_config */
function resolveViewConfig(activeView: string, viewConfig: ViewConfig | null | undefined, hideMode: string): ViewConfig {
  // Known preset → use it directly
  if (activeView in VIEW_PRESETS) {
    return VIEW_PRESETS[activeView]!;
  }
  // Custom view with config → use as-is
  if (activeView === "custom" && viewConfig) {
    return viewConfig;
  }
  // Legacy fallback: map old hide_mode to hideFilter
  return { hideFilter: hideMode === "all" ? "consensus" : "mine", favFilter: "all", hideConsensusMin: 1 };
}

export async function getAlbumLogic(userId: number, albumId: number): Promise<AlbumWithPhotos> {
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, albumId))
  );

  if (!album) {
    throw new Error("Album not found");
  }

  // Check access
  const isOwner = album.user_id === userId;
  const share = await dbFirst<typeof albumShares.$inferSelect>(
    db.select().from(albumShares).where(and(eq(albumShares.album_id, albumId), eq(albumShares.user_id, userId)))
  );

  if (!isOwner && !share) {
    throw new Error("Unauthorized access to album");
  }

  const role: "owner" | "admin" | "contributor" | "viewer" = isOwner ? "owner" : (share!.access_level === "write" ? "contributor" : "viewer");

  // Get user settings for this album
  let settings = await dbFirst<typeof albumUserSettings.$inferSelect>(
    db.select().from(albumUserSettings).where(and(eq(albumUserSettings.album_id, albumId), eq(albumUserSettings.user_id, userId)))
  );

  if (!settings) {
    // Create default settings if they don't exist
    await dbExec(db.insert(albumUserSettings).values({ album_id: albumId, user_id: userId, hide_mode: "mine", active_view: "all", cover_photo_id: null }));
    settings = { album_id: albumId, user_id: userId, hide_mode: "mine", active_view: "all", view_config: null, cover_photo_id: undefined };
  }

  const viewConfig = resolveViewConfig(settings.active_view, settings.view_config as ViewConfig | null, settings.hide_mode);

  // Determine album participant IDs (owner + shared users + AI user)
  const shareRows = await dbAll<{ user_id: number }>(
    db.select({ user_id: albumShares.user_id }).from(albumShares).where(eq(albumShares.album_id, albumId))
  );
  const humanParticipantIds = [album.user_id, ...shareRows.map(s => s.user_id)];
  const aiUserId = await getAiUserId();
  const participantIds = aiUserId ? [...humanParticipantIds, aiUserId] : humanParticipantIds;
  const memberCount = participantIds.length;

  // Use raw SQL for the aggregated query with curation stats
  const photoRows = (await db.execute(sql`
    SELECT
      p.id, p.user_id, p.filename, p.original_name, p.mime_type, p.size, p.hash,
      p.taken_at, p.created_at, p.ai_quality_score, p.auto_crop, p.description,
      p.latitude, p.longitude,
      p.location_name, p.location_city, p.location_country, p.location_short,
      ap.added_by_user_id, ap.added_at,
      my_pc.status AS curation_status,
      COALESCE(SUM(CASE WHEN all_pc.status = 'favorite' THEN 1 ELSE 0 END), 0)::int AS fav_count,
      COALESCE(SUM(CASE WHEN all_pc.status = 'hidden' THEN 1 ELSE 0 END), 0)::int AS hide_count
    FROM photos p
    INNER JOIN album_photos ap ON ap.photo_id = p.id AND ap.album_id = ${albumId}
    LEFT JOIN photo_curation my_pc ON my_pc.photo_id = p.id AND my_pc.user_id = ${userId}
    LEFT JOIN photo_curation all_pc ON all_pc.photo_id = p.id AND all_pc.user_id = ANY(ARRAY[${sql.join(participantIds.map(id => sql`${id}`), sql`, `)}]::int[])
    GROUP BY p.id, p.user_id, p.filename, p.original_name, p.mime_type, p.size, p.hash,
             p.taken_at, p.created_at, p.ai_quality_score, p.auto_crop, p.description,
             p.latitude, p.longitude,
             p.location_name, p.location_city, p.location_country, p.location_short,
             ap.added_by_user_id, ap.added_at, my_pc.status
  `)).rows;

  // Apply view filters in JS (cleaner than building dynamic HAVING clauses)
  const filteredPhotos = photoRows.filter((r: any) => {
    // ── Hide filter ──
    if (viewConfig.hideFilter === "mine") {
      if (r.curation_status === "hidden") return false;
    } else if (viewConfig.hideFilter === "consensus") {
      const min = viewConfig.hideConsensusMin ?? 1;
      if (r.hide_count >= min) return false;
    }
    // hideFilter === "none" → no filtering

    // ── Favorites filter ──
    if (viewConfig.favFilter === "mine") {
      if (r.curation_status !== "favorite") return false;
    } else if (viewConfig.favFilter === "any") {
      if (r.fav_count < 1) return false;
    } else if (viewConfig.favFilter === "consensus") {
      const min = viewConfig.favConsensusMin ?? 2;
      if (r.fav_count < min) return false;
    } else if (viewConfig.favFilter === "others-not-mine") {
      // Show photos favorited by at least one other participant but not by the current user
      if (r.fav_count < 1 || r.curation_status === "favorite") return false;
    }
    // favFilter === "all" → no filtering

    return true;
  });

  // Compute stats from filtered photos so count/timespan match what the user sees
  const filteredCount = filteredPhotos.length;
  let filteredNewest: string | undefined;
  let filteredOldest: string | undefined;
  let newestFilteredFilename: string | undefined;
  for (const p of filteredPhotos) {
    const d = p.taken_at || p.created_at;
    if (d) {
      if (!filteredNewest || d > filteredNewest) { filteredNewest = d; newestFilteredFilename = p.filename; }
      if (!filteredOldest || d < filteredOldest) { filteredOldest = d; }
    }
  }

  // Determine cover photo: prefer user-specific cover, then album's cover, then newest visible in album
  let coverFilename: string | undefined = undefined;
  let coverPhotoIdToUse: number | null | undefined = (settings as any).cover_photo_id;
  if (!coverPhotoIdToUse) {
    coverPhotoIdToUse = album.cover_photo_id ?? null;
  }
  if (coverPhotoIdToUse) {
    const cp = await dbFirst<any>(db.select({ filename: photos.filename }).from(photos).where(eq(photos.id, coverPhotoIdToUse)));
    coverFilename = cp?.filename;
  } else {
    coverFilename = newestFilteredFilename;
  }

  // Check if album is shared (has other participants)
  const isShared = memberCount > 1;

  return {
    id: album.id,
    user_id: album.user_id,
    name: album.name,
    description: album.description ?? undefined,
    cover_photo_id: album.cover_photo_id ?? undefined,
    cover_filename: coverFilename,
    display_mode: (album.display_mode as "grid" | "map") ?? "grid",
    newest_photo_at: filteredNewest,
    oldest_photo_at: filteredOldest,
    photo_count: filteredCount,
    is_shared: isShared,
    created_at: album.created_at ?? "",
    updated_at: album.updated_at ?? "",
    role,
    settings: {
      album_id: settings.album_id,
      user_id: settings.user_id,
      hide_mode: settings.hide_mode as "mine" | "all",
      active_view: settings.active_view as ActiveView,
      view_config: settings.view_config as ViewConfig | null,
      cover_photo_id: settings.cover_photo_id ?? undefined,
    },
    photos: filteredPhotos.map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      filename: r.filename,
      original_name: r.original_name,
      mime_type: r.mime_type,
      size: r.size,
      hash: r.hash ?? undefined,
      taken_at: r.taken_at ?? undefined,
      created_at: r.created_at ?? "",
      curation_status: (r.curation_status as CurationStatus) ?? "visible",
      added_by_user_id: r.added_by_user_id ?? undefined,
      added_at: r.added_at ?? "",
      auto_crop: r.auto_crop ?? undefined,
      latitude: r.latitude != null ? Number(r.latitude) : undefined,
      longitude: r.longitude != null ? Number(r.longitude) : undefined,
      location_name: r.location_name ?? undefined,
      location_city: r.location_city ?? undefined,
      location_country: r.location_country ?? undefined,
      location_short: r.location_short ?? undefined,
      description: r.description ?? undefined,
      curation_stats: isShared ? {
        fav_count: Number(r.fav_count),
        hide_count: Number(r.hide_count),
        member_count: memberCount,
      } : undefined,
    })),
  };
}

export async function updateAlbumUserSettingsLogic(userId: number, req: UpdateAlbumUserSettingsRequest): Promise<AlbumUserSettings> {
  // Verify the album exists and the user has access (owner or any share level)
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, req.albumId))
  );
  if (!album) throw new Error("Album not found");

  const isOwner = album.user_id === userId;
  if (!isOwner) {
    const share = await dbFirst<typeof albumShares.$inferSelect>(
      db.select().from(albumShares).where(and(eq(albumShares.album_id, req.albumId), eq(albumShares.user_id, userId)))
    );
    if (!share) throw new Error("Unauthorized access to album");
  }

  const values: any = {};
  if (req.hideMode) values.hide_mode = req.hideMode;
  if (req.activeView) values.active_view = req.activeView;
  if (req.viewConfig !== undefined) values.view_config = req.viewConfig;
  if (req.coverPhotoId !== undefined) {
    if (req.coverPhotoId === null) {
      values.cover_photo_id = null;
    } else {
      const ap = await dbFirst<typeof albumPhotos.$inferSelect>(
        db.select().from(albumPhotos).where(and(eq(albumPhotos.album_id, req.albumId), eq(albumPhotos.photo_id, req.coverPhotoId)))
      );
      if (!ap) throw new Error("Cover photo must be part of the album");
      values.cover_photo_id = req.coverPhotoId;
    }
  }

  // When switching to a preset, store corresponding view_config for consistency
  if (req.activeView && req.activeView in VIEW_PRESETS && req.viewConfig === undefined) {
    values.view_config = VIEW_PRESETS[req.activeView];
  }

  // Ensure settings row exists (may not if user never opened album detail view)
  await dbExec(
    db.insert(albumUserSettings)
      .values({ album_id: req.albumId, user_id: userId, hide_mode: "mine", active_view: "all", cover_photo_id: null })
      .onConflictDoNothing()
  );

  await dbExec(
    db.update(albumUserSettings)
      .set(values)
      .where(and(eq(albumUserSettings.album_id, req.albumId), eq(albumUserSettings.user_id, userId)))
  );

  const updated = await dbFirst<typeof albumUserSettings.$inferSelect>(
    db.select().from(albumUserSettings).where(and(eq(albumUserSettings.album_id, req.albumId), eq(albumUserSettings.user_id, userId)))
  );

  if (!updated) throw new Error("Settings not found");

  return {
    album_id: updated.album_id,
    user_id: updated.user_id,
    hide_mode: updated.hide_mode as "mine" | "all",
    active_view: updated.active_view as ActiveView,
    view_config: updated.view_config as ViewConfig | null,
    cover_photo_id: updated.cover_photo_id ?? undefined,
  };
}

export async function updateAlbumLogic(userId: number, req: UpdateAlbumRequest): Promise<Album> {
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, req.id))
  );
  if (!album) throw new Error("Album not found");

  // Check write access
  const isOwner = album.user_id === userId;
  const share = await dbFirst<typeof albumShares.$inferSelect>(
    db.select().from(albumShares).where(and(eq(albumShares.album_id, req.id), eq(albumShares.user_id, userId)))
  );

  if (!isOwner && (!share || share.access_level !== "write")) {
    throw new Error("Unauthorized to update album");
  }

  const values: any = { updated_at: new Date().toISOString() };
  if (req.name !== undefined) values.name = req.name;
  if (req.description !== undefined) values.description = req.description;
  if (req.displayMode !== undefined) values.display_mode = req.displayMode;
  if (req.coverPhotoId !== undefined) {
    if (req.coverPhotoId === null) {
      values.cover_photo_id = null;
    } else {
      // ensure the photo belongs to this album
      const ap = await dbFirst<typeof albumPhotos.$inferSelect>(
        db.select().from(albumPhotos).where(and(eq(albumPhotos.album_id, req.id), eq(albumPhotos.photo_id, req.coverPhotoId)))
      );
      if (!ap) throw new Error("Cover photo must be part of the album");
      values.cover_photo_id = req.coverPhotoId;
    }
  }

  await dbExec(
    db.update(albums).set(values).where(eq(albums.id, req.id))
  );

  const updated = (await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, req.id))
  ))!;
  const stats = await getAlbumStats(req.id, userId);
  let coverFilename: string | undefined = undefined;
  if (updated.cover_photo_id) {
    const cp = await dbFirst<any>(db.select({ filename: photos.filename }).from(photos).where(eq(photos.id, updated.cover_photo_id)));
    coverFilename = cp?.filename;
  } else {
    coverFilename = stats.newest_photo_filename;
  }

  return {
    id: updated.id,
    user_id: updated.user_id,
    name: updated.name,
    description: updated.description ?? undefined,
    cover_photo_id: updated.cover_photo_id ?? undefined,
    cover_filename: coverFilename,
    display_mode: (updated.display_mode as "grid" | "map") ?? "grid",
    newest_photo_at: stats.newest_photo_at,
    oldest_photo_at: stats.oldest_photo_at,
    photo_count: stats.photo_count,
    created_at: updated.created_at ?? "",
    updated_at: updated.updated_at ?? "",
  };
}

export async function deleteAlbumLogic(userId: number, albumId: number): Promise<DeleteResponse> {
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, albumId))
  );
  if (!album) throw new Error("Album not found");

  if (album.user_id !== userId) {
    throw new Error("Only owner can delete album");
  }

  await dbExec(db.delete(albums).where(eq(albums.id, albumId)));
  return { success: true, message: "Album deleted" };
}

export async function addPhotoToAlbumLogic(userId: number, req: AddPhotoToAlbumRequest): Promise<{ success: boolean }> {
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, req.albumId))
  );
  if (!album) throw new Error("Album not found");

  // Check write access
  const isOwner = album.user_id === userId;
  const share = await dbFirst<typeof albumShares.$inferSelect>(
    db.select().from(albumShares).where(and(eq(albumShares.album_id, req.albumId), eq(albumShares.user_id, userId)))
  );

  if (!isOwner && (!share || share.access_level !== "write")) {
    throw new Error("Unauthorized to add photos to album");
  }

  // Photo must be accessible to user (either owner or album is shared - wait, photo ownership is separate)
  // For now, let's say user can only add their OWN photos to albums they have write access to.
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(eq(photos.id, req.photoId))
  );
  if (!photo || photo.user_id !== userId) {
    throw new Error("Photo not found or not owned by user");
  }

  await dbExec(
    db.insert(albumPhotos).values({
      album_id: req.albumId,
      photo_id: req.photoId,
      added_by_user_id: userId,
      added_at: new Date().toISOString()
    })
  );

  // Enqueue face_assignment for all shared users of this album (not the owner — they
  // already have it from the upload).  Fire-and-forget so the API responds immediately.
  if (ENABLE_LOCAL_FACES) {
    const sharedUsers = await dbAll<{ user_id: number }>(
      db.select({ user_id: albumShares.user_id }).from(albumShares).where(eq(albumShares.album_id, req.albumId))
    );
    if (sharedUsers.length > 0) {
      // Bulk insert replaces N parallel enqueuePhotoScan() round-trips so
      // sharing an album with hundreds of users stays cheap.
      enqueuePhotoScanBulkPerUser(
        req.photoId,
        sharedUsers.map((s) => s.user_id),
        "face_assignment",
      )
        .then(() => triggerWorkers())
        .catch((err) => {
          console.error("Error enqueueing face assignments for shared album photo:", err);
        });
    }
  }

  // Re-run similar-photo grouping for shared users so the new photo is considered.
  // Scheduled per-user so rapid consecutive adds don't race each other.
  const sharedUsersForGrouping = await dbAll<{ user_id: number }>(
    db.select({ user_id: albumShares.user_id }).from(albumShares).where(eq(albumShares.album_id, req.albumId))
  );
  for (const { user_id } of sharedUsersForGrouping) {
    scheduleRegroup(user_id);
  }

  return { success: true };
}

export async function getPhotoAlbumsLogic(userId: number, photoIds: number[]): Promise<ListPhotoAlbumsResponse> {
  if (photoIds.length === 0) return { results: [] };

  const res = await dbAll<{ photo_id: number, album_id: number }>(
    db.select({ photo_id: albumPhotos.photo_id, album_id: albumPhotos.album_id })
      .from(albumPhotos)
      .innerJoin(albums, eq(albums.id, albumPhotos.album_id))
      .where(and(
        inArray(albumPhotos.photo_id, photoIds),
        or(
          eq(albums.user_id, userId),
          sql`EXISTS (SELECT 1 FROM ${albumShares} WHERE ${albumShares.album_id} = ${albums.id} AND ${albumShares.user_id} = ${userId})`
        )
      ))
  );

  const map = new Map<number, number[]>();
  photoIds.forEach(id => map.set(id, []));
  res.forEach(r => {
    map.get(r.photo_id)?.push(r.album_id);
  });

  return {
    results: Array.from(map.entries()).map(([photoId, albumIds]) => ({ photoId, albumIds }))
  };
}

/**
 * Jump destinations for a single photo. Lists all albums (owned or shared with
 * the user) the photo belongs to, all named persons the user has tagged in
 * faces on the photo, and whether the photo has GPS coordinates.
 */
export async function getPhotoLocationsLogic(
  userId: number,
  photoId: number
): Promise<import("../db/types").PhotoLocationsResponse> {
  // Verify the photo exists and belongs to the user.
  const photo = await dbFirst<{ id: number; user_id: number; latitude: number | null; longitude: number | null }>(
    db.select({
      id: photos.id,
      user_id: photos.user_id,
      latitude: photos.latitude,
      longitude: photos.longitude,
    }).from(photos).where(eq(photos.id, photoId))
  );
  if (!photo) throw APIError.notFound("photo not found");
  if (photo.user_id !== userId) {
    // The photo is visible to the user only if it appears in an album they
    // own or that has been shared with them.
    const sharedHit = await dbFirst<{ exists: number }>(
      db.select({ exists: sql<number>`1` }).from(albumPhotos)
        .innerJoin(albums, eq(albums.id, albumPhotos.album_id))
        .where(and(
          eq(albumPhotos.photo_id, photoId),
          or(
            eq(albums.user_id, userId),
            sql`EXISTS (SELECT 1 FROM ${albumShares} WHERE ${albumShares.album_id} = ${albums.id} AND ${albumShares.user_id} = ${userId})`
          )
        )).limit(1)
    );
    if (!sharedHit) throw APIError.permissionDenied("not allowed");
  }

  const albumRows = await dbAll<{ id: number; name: string }>(
    db.select({ id: albums.id, name: albums.name })
      .from(albumPhotos)
      .innerJoin(albums, eq(albums.id, albumPhotos.album_id))
      .where(and(
        eq(albumPhotos.photo_id, photoId),
        or(
          eq(albums.user_id, userId),
          sql`EXISTS (SELECT 1 FROM ${albumShares} WHERE ${albumShares.album_id} = ${albums.id} AND ${albumShares.user_id} = ${userId})`
        )
      ))
  );

  const personRows = await dbAll<{ id: number; name: string }>(
    db.selectDistinct({ id: persons.id, name: persons.name })
      .from(userFaceAssignments)
      .innerJoin(faces, eq(faces.id, userFaceAssignments.face_id))
      .innerJoin(persons, eq(persons.id, userFaceAssignments.person_id))
      .where(and(
        eq(userFaceAssignments.user_id, userId),
        eq(userFaceAssignments.ignored, false),
        eq(faces.photo_id, photoId),
        isNotNull(userFaceAssignments.person_id),
        eq(persons.user_id, userId)
      ))
  );

  // Filter out unnamed persons (default "Unbenannt").
  const namedPersons = personRows.filter(
    p => !!p.name && p.name.trim().toLowerCase() !== "unbenannt"
  );

  const hasGps =
    photo.latitude !== null && photo.latitude !== undefined &&
    photo.longitude !== null && photo.longitude !== undefined;

  // Stable order: alphabetical by name.
  albumRows.sort((a, b) => a.name.localeCompare(b.name));
  namedPersons.sort((a, b) => a.name.localeCompare(b.name));

  return {
    photoId,
    albums: albumRows,
    persons: namedPersons,
    hasGps,
  };
}

export async function batchUpdateAlbumPhotosLogic(userId: number, req: BatchAlbumPhotosRequest): Promise<{ success: boolean }> {
  const { albumIds, photoIds, action } = req;
  if (albumIds.length === 0 || photoIds.length === 0) return { success: true };

  // Check write access for all albums
  for (const albumId of albumIds) {
    const album = await dbFirst<typeof albums.$inferSelect>(
      db.select().from(albums).where(eq(albums.id, albumId))
    );
    if (!album) throw new Error(`Album ${albumId} not found`);

    const isOwner = album.user_id === userId;
    const share = await dbFirst<typeof albumShares.$inferSelect>(
      db.select().from(albumShares).where(and(eq(albumShares.album_id, albumId), eq(albumShares.user_id, userId)))
    );

    if (!isOwner && (!share || share.access_level !== "write")) {
      throw new Error(`Unauthorized to modify album ${albumId}`);
    }
  }

  // Check photo ownership
  const ownedPhotos = await dbAll<{ id: number }>(
    db.select({ id: photos.id })
      .from(photos)
      .where(and(inArray(photos.id, photoIds), eq(photos.user_id, userId)))
  );
  if (ownedPhotos.length !== photoIds.length) {
    throw new Error("One or more photos not found or not owned by user");
  }

  if (action === "add") {
    for (const albumId of albumIds) {
      for (const photoId of photoIds) {
        const exists = await dbFirst(
          db.select().from(albumPhotos).where(and(eq(albumPhotos.album_id, albumId), eq(albumPhotos.photo_id, photoId)))
        );
        if (!exists) {
          await dbExec(
            db.insert(albumPhotos).values({
              album_id: albumId,
              photo_id: photoId,
              added_by_user_id: userId,
              added_at: new Date().toISOString()
            })
          );
        }
      }

      // Enqueue face_assignment for all shared users of this album
      if (ENABLE_LOCAL_FACES) {
        const sharedUsers = await dbAll<{ user_id: number }>(
          db.select({ user_id: albumShares.user_id }).from(albumShares).where(eq(albumShares.album_id, albumId))
        );
        if (sharedUsers.length > 0) {
          Promise.all(
            sharedUsers.flatMap(({ user_id }) =>
              photoIds.map(photoId => enqueuePhotoScan(photoId, user_id, ["face_assignment"]))
            )
          ).then(() => triggerWorkers()).catch(err => {
            console.error("Error enqueueing face assignments for batch album add:", err);
          });
        }
      }
    }
  } else if (action === "remove") {
    await dbExec(
      db.delete(albumPhotos).where(and(
        inArray(albumPhotos.album_id, albumIds),
        inArray(albumPhotos.photo_id, photoIds)
      ))
    );
  }

  return { success: true };
}

export async function shareAlbumLogic(userId: number, req: ShareAlbumRequest): Promise<{ success: boolean }> {
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, req.albumId))
  );
  if (!album) throw new Error("Album not found");

  if (album.user_id !== userId) {
    throw new Error("Only owner can share album");
  }

  await dbExec(
    db.insert(albumShares)
      .values({ album_id: req.albumId, user_id: req.userId, access_level: req.accessLevel })
      .onConflictDoUpdate({ target: [albumShares.album_id, albumShares.user_id], set: { access_level: req.accessLevel } })
  );

  // Enqueue face_assignment jobs for all photos in the shared album for the new user.
  // This way, the new user immediately gets face data without re-running InsightFace.
  enqueueAlbumFaceAssignments(req.albumId, req.userId).catch(err => {
    console.error(`Error enqueueing face assignments for shared album ${req.albumId}:`, err);
  });

  // Re-run similar-photo grouping for the new shared user so shared photos are considered.
  scheduleRegroup(req.userId);

  return { success: true };
}

/**
 * Enqueue face_assignment jobs for all photos in an album for a specific user.
 * Called when an album is shared — the new user gets face assignments without re-running detection.
 */
async function enqueueAlbumFaceAssignments(albumId: number, targetUserId: number): Promise<void> {
  if (!ENABLE_LOCAL_FACES) return;

  const albumPhotoRows = await dbAll<{ photo_id: number }>(
    db.select({ photo_id: albumPhotos.photo_id }).from(albumPhotos).where(eq(albumPhotos.album_id, albumId))
  );

  console.log(`[face-assign] Enqueueing face_assignment for ${albumPhotoRows.length} photos in album ${albumId} for user ${targetUserId}`);

  for (const { photo_id } of albumPhotoRows) {
    await enqueuePhotoScan(photo_id, targetUserId, ["face_assignment"]);
  }

  if (albumPhotoRows.length > 0) {
    triggerWorkers();
  }
}

export async function getAlbumSharesLogic(userId: number, albumId: number): Promise<GetAlbumSharesResponse> {
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, albumId))
  );
  if (!album) throw new Error("Album not found");
  if (album.user_id !== userId) throw new Error("Only owner can view shares");

  const rows = await dbAll<{ album_id: number; user_id: number; access_level: string; name: string; email: string }>(
    db.select({
      album_id: albumShares.album_id,
      user_id: albumShares.user_id,
      access_level: albumShares.access_level,
      name: users.name,
      email: users.email,
    })
    .from(albumShares)
    .innerJoin(users, eq(users.id, albumShares.user_id))
    .where(eq(albumShares.album_id, albumId))
  );

  // Also fetch public link if it exists
  const publicLink = await dbFirst<typeof albumPublicLinks.$inferSelect>(
    db.select().from(albumPublicLinks).where(eq(albumPublicLinks.album_id, albumId))
  );

  return {
    shares: rows.map(r => ({
      album_id: r.album_id,
      user_id: r.user_id,
      access_level: r.access_level as "read" | "write",
      user_name: r.name,
      user_email: r.email,
    })),
    publicLink: publicLink ? toPublicLinkResponse(publicLink) : undefined,
  };
}

export async function removeAlbumShareLogic(userId: number, req: RemoveAlbumShareRequest): Promise<{ success: boolean }> {
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, req.albumId))
  );
  if (!album) throw new Error("Album not found");
  if (album.user_id !== userId) throw new Error("Only owner can remove shares");

  // Collect photo IDs in this album BEFORE deleting the share
  const albumPhotoIds = (await dbAll<{ photo_id: number }>(
    db.select({ photo_id: albumPhotos.photo_id }).from(albumPhotos).where(eq(albumPhotos.album_id, req.albumId))
  )).map(r => r.photo_id);

  await dbExec(
    db.delete(albumShares).where(and(eq(albumShares.album_id, req.albumId), eq(albumShares.user_id, req.userId)))
  );

  // Clean up face assignments, queue entries, and orphaned persons for the
  // unshared user — but only for photos they no longer have access to.
  if (albumPhotoIds.length > 0) {
    cleanupAfterUnshare(req.userId, albumPhotoIds).catch(err => {
      console.error(`Error cleaning up after unshare of album ${req.albumId}:`, err);
    });
  }

  // Re-run grouping so removed shared photos are no longer in groups.
  scheduleRegroup(req.userId);

  return { success: true };
}

/**
 * After an album share is removed, delete the user's face data for photos
 * they no longer have access to (not owned and not in any other shared album).
 */
async function cleanupAfterUnshare(sharedUserId: number, albumPhotoIds: number[]): Promise<void> {
  // Find which of these photos the user still has access to
  // (owns the photo OR has access through another shared album).
  const stillAccessibleResult = await db.execute<{ photo_id: number }>(sql`
    SELECT DISTINCT photo_id FROM (
      -- Photos owned by the user
      SELECT id AS photo_id FROM photos WHERE user_id = ${sharedUserId} AND id IN (${sql.join(albumPhotoIds.map(id => sql`${id}`), sql`, `)})
      UNION
      -- Photos accessible through other shared albums
      SELECT ap.photo_id
      FROM album_photos ap
      INNER JOIN album_shares ash ON ash.album_id = ap.album_id AND ash.user_id = ${sharedUserId}
      WHERE ap.photo_id IN (${sql.join(albumPhotoIds.map(id => sql`${id}`), sql`, `)})
    ) accessible
  `);
  const stillAccessibleSet = new Set(stillAccessibleResult.rows.map(r => r.photo_id));
  const orphanedPhotoIds = albumPhotoIds.filter(id => !stillAccessibleSet.has(id));

  if (orphanedPhotoIds.length === 0) return;

  console.log(`[unshare] Cleaning up ${orphanedPhotoIds.length} orphaned photos for user ${sharedUserId}`);

  // Get face IDs for the orphaned photos
  const orphanedFaceIds = (await dbAll<{ id: number }>(
    db.select({ id: faces.id }).from(faces).where(inArray(faces.photo_id, orphanedPhotoIds))
  )).map(r => r.id);

  if (orphanedFaceIds.length > 0) {
    // Delete user_face_assignments for these faces
    await dbExec(
      db.delete(userFaceAssignments).where(and(
        eq(userFaceAssignments.user_id, sharedUserId),
        inArray(userFaceAssignments.face_id, orphanedFaceIds)
      ))
    );
  }

  // Remove all face_assignment queue entries for these photos
  await dbExec(
    db.delete(photoScanQueue).where(and(
      eq(photoScanQueue.user_id, sharedUserId),
      inArray(photoScanQueue.photo_id, orphanedPhotoIds),
      eq(photoScanQueue.service, "face_assignment"),
    ))
  );

  // Clean up orphaned persons (persons with no remaining face assignments)
  await cleanupOrphanedPersons(sharedUserId);
}

// ---------- Album Public Links ----------

function toPublicLinkResponse(row: typeof albumPublicLinks.$inferSelect): AlbumPublicLink {
  return {
    id: row.id,
    album_id: row.album_id,
    token: row.token,
    created_by_user_id: row.created_by_user_id,
    created_at: row.created_at ?? "",
    expires_at: row.expires_at ?? undefined,
  };
}

const EXPIRES_IN_MS: Record<string, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export async function createAlbumPublicLinkLogic(userId: number, albumId: number, expiresIn?: string): Promise<AlbumPublicLink> {
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, albumId))
  );
  if (!album) throw new Error("Album not found");
  if (album.user_id !== userId) throw new Error("Only owner can create public link");

  // Check if a link already exists
  const existing = await dbFirst<typeof albumPublicLinks.$inferSelect>(
    db.select().from(albumPublicLinks).where(eq(albumPublicLinks.album_id, albumId))
  );
  if (existing) {
    return toPublicLinkResponse(existing);
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = expiresIn && EXPIRES_IN_MS[expiresIn]
    ? new Date(Date.now() + EXPIRES_IN_MS[expiresIn]).toISOString()
    : undefined;

  const row = await dbInsertReturning<typeof albumPublicLinks.$inferSelect>(
    db.insert(albumPublicLinks).values({
      album_id: albumId,
      token,
      created_by_user_id: userId,
      expires_at: expiresAt,
    }).returning()
  );

  return toPublicLinkResponse(row);
}

export async function deleteAlbumPublicLinkLogic(userId: number, albumId: number): Promise<{ success: boolean }> {
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, albumId))
  );
  if (!album) throw new Error("Album not found");
  if (album.user_id !== userId) throw new Error("Only owner can delete public link");

  await dbExec(
    db.delete(albumPublicLinks).where(eq(albumPublicLinks.album_id, albumId))
  );
  return { success: true };
}

export async function getPublicAlbumLogic(token: string): Promise<PublicAlbumResponse> {
  const link = await dbFirst<typeof albumPublicLinks.$inferSelect>(
    db.select().from(albumPublicLinks).where(eq(albumPublicLinks.token, token))
  );
  if (!link) throw APIError.notFound("Dieser Link ist ungültig oder existiert nicht mehr.");

  // Check expiration
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    throw APIError.notFound("Dieser Link ist abgelaufen.");
  }

  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, link.album_id))
  );
  if (!album) throw new Error("Album not found");

  const stats = await getAlbumStats(link.album_id);

  // Get all photos in the album (no curation filtering for public view)
  const photoRows = (await db.execute(sql`
    SELECT
      p.id, p.filename, p.original_name, p.mime_type, p.size,
      p.taken_at, p.created_at, p.ai_quality_score, p.auto_crop, p.description,
      p.latitude, p.longitude,
      p.location_name, p.location_city, p.location_country, p.location_short
    FROM photos p
    INNER JOIN album_photos ap ON ap.photo_id = p.id AND ap.album_id = ${link.album_id}
    ORDER BY p.taken_at ASC NULLS LAST, p.created_at ASC
  `)).rows;

  // Determine cover
  let coverFilename: string | undefined;
  if (album.cover_photo_id) {
    const cp = await dbFirst<any>(db.select({ filename: photos.filename }).from(photos).where(eq(photos.id, album.cover_photo_id)));
    coverFilename = cp?.filename;
  } else {
    coverFilename = stats.newest_photo_filename;
  }

  return {
    id: album.id,
    name: album.name,
    description: album.description ?? undefined,
    display_mode: (album.display_mode as "grid" | "map") ?? "grid",
    cover_filename: coverFilename,
    newest_photo_at: stats.newest_photo_at,
    oldest_photo_at: stats.oldest_photo_at,
    photo_count: stats.photo_count,
    photos: photoRows.map((r: any) => ({
      id: r.id,
      filename: r.filename,
      original_name: r.original_name,
      mime_type: r.mime_type,
      size: r.size,
      taken_at: r.taken_at ?? undefined,
      created_at: r.created_at ?? "",
      latitude: r.latitude != null ? Number(r.latitude) : undefined,
      longitude: r.longitude != null ? Number(r.longitude) : undefined,
      location_name: r.location_name ?? undefined,
      location_city: r.location_city ?? undefined,
      location_country: r.location_country ?? undefined,
      location_short: r.location_short ?? undefined,
      ai_quality_score: r.ai_quality_score != null ? Number(r.ai_quality_score) : undefined,
      auto_crop: r.auto_crop ?? undefined,
      description: r.description ?? undefined,
    })),
  };
}

async function findBestPersonMatch(
  userId: number,
  embedding: number[]
): Promise<{ personId: number; distance: number } | null> {
  const allFaces = await dbAll<{ person_id: number | null; embedding: string }>(
    db
      .select({ person_id: userFaceAssignments.person_id, embedding: faces.embedding })
      .from(userFaceAssignments)
      .innerJoin(faces, eq(faces.id, userFaceAssignments.face_id))
      .where(and(
        eq(userFaceAssignments.user_id, userId),
        sql`${userFaceAssignments.person_id} IS NOT NULL`,
        eq(userFaceAssignments.ignored, false)
      ))
  );

  // Group embeddings by person
  const personEmbeddings: Record<number, number[][]> = {};
  for (const face of allFaces) {
    if (!personEmbeddings[face.person_id!]) {
      personEmbeddings[face.person_id!] = [];
    }
    personEmbeddings[face.person_id!].push(JSON.parse(face.embedding as string) as number[]);
  }

  let bestMatch: { personId: number; distance: number } | null = null;

  for (const [personIdStr, embeddings] of Object.entries(personEmbeddings)) {
    const personId = parseInt(personIdStr);

    const centroid = computeCentroid(embeddings);
    const similarity = cosineSimilarity(embedding, centroid);

    if (similarity > FACE_SIMILARITY_THRESHOLD) {
      if (!bestMatch || similarity > bestMatch.distance) {
        bestMatch = { personId, distance: similarity };
      }
    }
  }

  return bestMatch;
}

/**
 * Compute the centroid (mean) of a set of embedding vectors.
 */
function computeCentroid(embeddings: number[][]): number[] {
  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= embeddings.length;
  }
  return centroid;
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(v1: number[], v2: number[]): number {
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  for (let i = 0; i < v1.length; i++) {
    dotProduct += v1[i] * v2[i];
    norm1 += v1[i] * v1[i];
    norm2 += v2[i] * v2[i];
  }
  if (norm1 === 0 || norm2 === 0) return 0;
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

function calculateOverlap(b1: any, b2: any): number {
  const x1 = Math.max(b1.x, b2.x);
  const y1 = Math.max(b1.y, b2.y);
  const x2 = Math.min(b1.x + b1.width, b2.x + b2.width);
  const y2 = Math.min(b1.y + b1.height, b2.y + b2.height);

  if (x1 >= x2 || y1 >= y2) return 0;

  const intersectionArea = (x2 - x1) * (y2 - y1);
  const area1 = b1.width * b1.height;
  const area2 = b2.width * b2.height;
  const unionArea = area1 + area2 - intersectionArea;

  if (unionArea === 0) return 0;
  return intersectionArea / unionArea;
}

export async function listPersonsLogic(userId: number): Promise<ListPersonsResponse> {
  const rows = await dbAll<{
    id: number; user_id: number; name: string; cover_face_id: number | null;
    created_at: string | null; updated_at: string | null; faceCount: number;
    cover_filename: string | null; cover_bbox: string | null;
    oldest_photo_at: string | null; newest_photo_at: string | null;
  }>(db.select({
      id: persons.id,
      user_id: persons.user_id,
      name: persons.name,
      cover_face_id: sql<number>`COALESCE(
        (
          SELECT f.id
          FROM user_face_assignments ufa
          INNER JOIN faces f ON f.id = ufa.face_id
          INNER JOIN photos p ON p.id = f.photo_id
          WHERE ufa.person_id = persons.id
            AND ufa.user_id = persons.user_id
            AND ufa.ignored = ${rawFalse}
          ORDER BY ${rawCoalesceDate} DESC NULLS LAST, f.id DESC
          LIMIT 1
        ),
        persons.cover_face_id
      )`,
      created_at: persons.created_at,
      updated_at: persons.updated_at,
      faceCount: sql<number>`CAST(COALESCE((SELECT count(*) FROM user_face_assignments ufa WHERE ufa.person_id = persons.id AND ufa.ignored = ${rawFalse}), 0) AS INTEGER)`,
      cover_filename: sql<string>`COALESCE(
        (
          SELECT p.filename
          FROM user_face_assignments ufa
          INNER JOIN faces f ON f.id = ufa.face_id
          INNER JOIN photos p ON p.id = f.photo_id
          WHERE ufa.person_id = persons.id
            AND ufa.user_id = persons.user_id
            AND ufa.ignored = ${rawFalse}
          ORDER BY ${rawCoalesceDate} DESC NULLS LAST, f.id DESC
          LIMIT 1
        ),
        ''
      )`,
      cover_bbox: sql<string>`COALESCE(
        (
          SELECT f.bbox
          FROM user_face_assignments ufa
          INNER JOIN faces f ON f.id = ufa.face_id
          INNER JOIN photos p ON p.id = f.photo_id
          WHERE ufa.person_id = persons.id
            AND ufa.user_id = persons.user_id
            AND ufa.ignored = ${rawFalse}
          ORDER BY ${rawCoalesceDate} DESC NULLS LAST, f.id DESC
          LIMIT 1
        ),
        ''
      )`,
      oldest_photo_at: sql<string>`(
        SELECT MIN(${rawCoalesceDate})::text
        FROM user_face_assignments ufa
        INNER JOIN faces f ON f.id = ufa.face_id
        INNER JOIN photos p ON p.id = f.photo_id
        WHERE ufa.person_id = persons.id
          AND ufa.user_id = persons.user_id
          AND ufa.ignored = ${rawFalse}
      )`,
      newest_photo_at: sql<string>`(
        SELECT MAX(${rawCoalesceDate})::text
        FROM user_face_assignments ufa
        INNER JOIN faces f ON f.id = ufa.face_id
        INNER JOIN photos p ON p.id = f.photo_id
        WHERE ufa.person_id = persons.id
          AND ufa.user_id = persons.user_id
          AND ufa.ignored = ${rawFalse}
      )`,
    })
    .from(persons)
    .where(eq(persons.user_id, userId))
    .orderBy(sql`${persons.updated_at} DESC`)
  );

  return {
    persons: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      name: r.name,
      cover_face_id: r.cover_face_id ?? undefined,
      created_at: r.created_at ?? "",
      updated_at: r.updated_at ?? "",
      faceCount: r.faceCount,
      cover_filename: r.cover_filename ?? undefined,
      cover_bbox: r.cover_bbox ? JSON.parse(r.cover_bbox) : undefined,
      oldest_photo_at: r.oldest_photo_at ?? undefined,
      newest_photo_at: r.newest_photo_at ?? undefined,
    })),
    enableLocalFaces: ENABLE_LOCAL_FACES,
  };
}

export async function getPersonDetailsLogic(userId: number, personId: number): Promise<PersonDetails> {
  const person = await dbFirst<typeof persons.$inferSelect>(
    db.select().from(persons).where(and(eq(persons.id, personId), eq(persons.user_id, userId)))
  );
  if (!person) throw new Error("Person not found");

  const faceRows = await dbAll<{
    id: number; user_id: number; photo_id: number; bbox: string; embedding: string;
    person_id: number | null; quality: number | null; ignored: boolean | null;
    created_at: string | null; filename: string; original_name: string; taken_at: string | null;
  }>(
    db
      .select({
        id: faces.id,
        user_id: userFaceAssignments.user_id,
        photo_id: faces.photo_id,
        bbox: faces.bbox,
        embedding: faces.embedding,
        person_id: userFaceAssignments.person_id,
        quality: faces.quality,
        ignored: userFaceAssignments.ignored,
        created_at: faces.created_at,
        filename: photos.filename,
        original_name: photos.original_name,
        taken_at: photos.taken_at,
      })
      .from(userFaceAssignments)
      .innerJoin(faces, eq(faces.id, userFaceAssignments.face_id))
      .innerJoin(photos, eq(faces.photo_id, photos.id))
      .where(and(eq(userFaceAssignments.person_id, personId), eq(userFaceAssignments.user_id, userId)))
      .orderBy(sql`${photoDateOrder} DESC NULLS LAST`, sql`${faces.id} DESC`)
  );

  return {
    id: person.id,
    user_id: person.user_id,
    name: person.name,
    cover_face_id: person.cover_face_id ?? undefined,
    created_at: person.created_at ?? "",
    updated_at: person.updated_at ?? "",
    faces: faceRows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      photo_id: r.photo_id,
      bbox: JSON.parse(r.bbox),
      embedding: JSON.parse(r.embedding),
      person_id: r.person_id ?? undefined,
      quality: r.quality ?? undefined,
      ignored: !!r.ignored,
      created_at: r.created_at ?? "",
      photo: {
        id: r.photo_id,
        user_id: r.user_id,
        filename: r.filename,
        original_name: r.original_name,
        taken_at: r.taken_at ?? undefined,
        created_at: "",
      },
    })),
  };
}

export async function updatePersonLogic(userId: number, personId: number, name: string): Promise<Person & { faceCount: number }> {
  if (name.trim().toLowerCase() === "unbenannt") {
    throw new Error("Person kann nicht in 'Unbenannt' umbenannt werden");
  }

  await dbExec(
    db.update(persons)
      .set({ name, updated_at: new Date().toISOString() })
      .where(and(eq(persons.id, personId), eq(persons.user_id, userId)))
  );

  const updated = (await dbFirst<{
    id: number; user_id: number; name: string; cover_face_id: number | null;
    created_at: string | null; updated_at: string | null; faceCount: number;
    cover_filename: string; cover_bbox: string;
  }>(
    db
      .select({
        id: persons.id,
        user_id: persons.user_id,
        name: persons.name,
        cover_face_id: persons.cover_face_id,
        created_at: persons.created_at,
        updated_at: persons.updated_at,
        faceCount: sql<number>`CAST(COALESCE((SELECT count(*) FROM user_face_assignments ufa WHERE ufa.person_id = persons.id AND ufa.ignored = ${rawFalse}), 0) AS INTEGER)`,
        cover_filename: sql<string>`COALESCE((SELECT p.filename FROM photos p INNER JOIN faces f ON f.photo_id = p.id WHERE f.id = persons.cover_face_id LIMIT 1), '')`,
        cover_bbox: sql<string>`COALESCE((SELECT f.bbox FROM faces f WHERE f.id = persons.cover_face_id LIMIT 1), '')`,
      })
      .from(persons)
      .where(eq(persons.id, personId))
  ))!;

  return {
    id: updated.id,
    user_id: updated.user_id,
    name: updated.name,
    cover_face_id: updated.cover_face_id ?? undefined,
    cover_filename: updated.cover_filename ?? undefined,
    cover_bbox: updated.cover_bbox ? JSON.parse(updated.cover_bbox) : undefined,
    created_at: updated.created_at ?? "",
    updated_at: updated.updated_at ?? "",
    faceCount: updated.faceCount,
  };
}

export async function mergePersonsLogic(userId: number, req: MergePersonsRequest): Promise<{ success: boolean }> {
  const targetId = req.targetId;
  const sourceIds = req.sourceIds.filter(id => id !== targetId);

  if (sourceIds.length === 0) {
    return { success: true };
  }

  const target = await dbFirst<typeof persons.$inferSelect>(
    db.select().from(persons).where(and(eq(persons.id, targetId), eq(persons.user_id, userId)))
  );
  if (!target) throw new Error("Target person not found");
  if (target.name === "Unbenannt") {
    throw new Error("Kann nicht zu einer unbenannten Person zusammenführen");
  }

  // Move all face assignments from source persons to target person
  await dbExec(
    db.update(userFaceAssignments)
      .set({ person_id: targetId })
      .where(and(inArray(userFaceAssignments.person_id, sourceIds), eq(userFaceAssignments.user_id, userId)))
  );

  // Update target person's cover face if it doesn't have one
  if (!target.cover_face_id) {
    const firstFace = await dbFirst<{ face_id: number }>(
      db.select({ face_id: userFaceAssignments.face_id })
        .from(userFaceAssignments)
        .where(and(eq(userFaceAssignments.person_id, targetId), eq(userFaceAssignments.user_id, userId)))
        .limit(1)
    );
    if (firstFace) {
      await dbExec(
        db.update(persons).set({ cover_face_id: firstFace.face_id }).where(eq(persons.id, targetId))
      );
    }
  }

  // Set updated_at for target person
  await dbExec(
    db.update(persons).set({ updated_at: new Date().toISOString() }).where(eq(persons.id, targetId))
  );

  // Delete source persons
  await dbExec(
    db.delete(persons).where(and(inArray(persons.id, sourceIds), eq(persons.user_id, userId)))
  );

  return { success: true };
}

export async function assignFaceToPersonLogic(
  userId: number,
  faceId: number,
  personId: number
): Promise<{ success: boolean }> {
  await dbExec(
    db.update(userFaceAssignments)
      .set({ person_id: personId, ignored: false })
      .where(and(eq(userFaceAssignments.face_id, faceId), eq(userFaceAssignments.user_id, userId)))
  );
  return { success: true };
}

export async function ignoreFaceLogic(
  userId: number,
  faceId: number
): Promise<{ success: boolean }> {
  await dbExec(
    db.update(userFaceAssignments)
      .set({ ignored: true, person_id: null })
      .where(and(eq(userFaceAssignments.face_id, faceId), eq(userFaceAssignments.user_id, userId)))
  );
  return { success: true };
}

export async function ignorePersonFacesLogic(
  userId: number,
  personId: number
): Promise<{ success: boolean }> {
  await dbExec(
    db.update(userFaceAssignments)
      .set({ ignored: true, person_id: null })
      .where(and(eq(userFaceAssignments.person_id, personId), eq(userFaceAssignments.user_id, userId)))
  );

  // Also cleanup the person since they no longer have any associated faces
  await cleanupOrphanedPersons(userId);

  return { success: true };
}

export async function getPhotoFacesLogic(
  userId: number,
  photoId: number
): Promise<{ faces: Face[] }> {
  const rows = await dbAll<{
    id: number; user_id: number; photo_id: number; bbox: string; embedding: string;
    person_id: number | null; quality: number | null; ignored: boolean;
    created_at: string | null;
  }>(
    db.select({
      id: faces.id,
      user_id: userFaceAssignments.user_id,
      photo_id: faces.photo_id,
      bbox: faces.bbox,
      embedding: faces.embedding,
      person_id: userFaceAssignments.person_id,
      quality: faces.quality,
      ignored: userFaceAssignments.ignored,
      created_at: faces.created_at,
    })
    .from(faces)
    .innerJoin(userFaceAssignments, and(
      eq(userFaceAssignments.face_id, faces.id),
      eq(userFaceAssignments.user_id, userId)
    ))
    .where(eq(faces.photo_id, photoId))
  );

  return {
    faces: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      photo_id: r.photo_id,
      bbox: JSON.parse(r.bbox),
      embedding: JSON.parse(r.embedding),
      person_id: r.person_id ?? undefined,
      quality: r.quality ?? undefined,
      ignored: !!r.ignored,
      created_at: r.created_at ?? "",
    })),
  };
}

export async function reindexPhotoLogic(
  userId: number,
  photoId: number
): Promise<{ success: boolean }> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );
  if (!photo) throw new Error("Photo not found");

  await indexPhotoFaces(userId, photoId, true);
  await indexPhotoEmbeddings(photoId, true);
  if (ENABLE_LANDMARKS) {
    await indexPhotoLandmarks(photoId);
  }
  let lat = photo.latitude;
  let lon = photo.longitude;

  if (lat === null || lon === null) {
    const filePath = getPhotoDiskPath(photo);
    const exifMeta = await getExifMetadata(filePath);
    if (exifMeta.latitude !== null && exifMeta.longitude !== null) {
      lat = exifMeta.latitude;
      lon = exifMeta.longitude;
      await dbExec(
        db.update(photos).set({ latitude: lat, longitude: lon }).where(eq(photos.id, photoId))
      );
    }
  }

  if (lat !== null && lon !== null && !photo.location_name) {
    await geocodePhotoLocation(photoId, lat, lon);
  }
  return { success: true };
}


// ── GPS Rescan ───────────────────────────────────────────────────────────────

/**
 * Returns IDs of photos that need GPS processing:
 * - latitude IS NULL  → EXIF extraction never succeeded, worth retrying
 * - latitude set but location_name IS NULL → geocoding failed, worth retrying
 */
export async function getPhotosNeedingGpsRescanLogic(userId: number): Promise<{ ids: number[] }> {
  const rows = await dbAll<{ id: number }>(
    db.select({ id: photos.id })
      .from(photos)
      .where(
        and(
          eq(photos.user_id, userId),
          or(
            isNull(photos.latitude),
            and(isNotNull(photos.latitude), isNull(photos.location_name)),
          ),
        )
      )
  );
  return { ids: rows.map(r => r.id) };
}

/**
 * Re-extracts GPS for a single photo and reverse-geocodes if needed.
 * When GPS coordinates are newly found the photo is also enqueued for all
 * other scan services — a failed EXIF extraction suggests the photo may not
 * have been fully processed on upload.
 */
export async function rescanPhotoGpsLogic(
  userId: number,
  photoId: number,
): Promise<{ gpsFound: boolean; geocoded: boolean; scansQueued: boolean }> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );
  if (!photo) throw new Error("Photo not found");

  let lat = photo.latitude;
  let lon = photo.longitude;
  let gpsFound = false;
  let geocoded = false;
  let scansQueued = false;
  let iptcLoc: ReturnType<typeof iptcLocationUpdate> = null;

  const filePath = getPhotoDiskPath(photo);
  if (fs.existsSync(filePath)) {
    const exifMeta = await getExifMetadata(filePath);
    if ((lat === null || lon === null) && exifMeta.latitude !== null && exifMeta.longitude !== null) {
      lat = exifMeta.latitude;
      lon = exifMeta.longitude;
      await dbExec(
        db.update(photos).set({ latitude: lat, longitude: lon }).where(eq(photos.id, photoId))
      );
      gpsFound = true;
      // EXIF parsing previously failed → re-queue all scan services
      await enqueuePhotoScan(photoId, userId);
      triggerWorkers();
      scansQueued = true;
    }
    iptcLoc = iptcLocationUpdate(exifMeta);
  } else if (lat === null || lon === null) {
    return { gpsFound: false, geocoded: false, scansQueued: false };
  }

  if (!photo.location_name) {
    if (iptcLoc) {
      // IPTC location block on the file – trust it and skip Nominatim.
      await dbExec(
        db.update(photos).set(iptcLoc).where(eq(photos.id, photoId))
      );
      geocoded = true;
    } else if (lat !== null && lon !== null) {
      await geocodePhotoLocation(photoId, lat, lon);
      geocoded = true;
    }
  }

  return { gpsFound, geocoded, scansQueued };
}

// ── Scan Queue API helpers ───────────────────────────────────────────────────

import { getQueueStatus, requeueFailed, requeueForRescan, cancelPendingScans } from "./scan-queue";
import {
  requeueFailedLibraryScans,
  cancelPendingLibraryScans,
} from "./library-scan-queue";

export async function getScanQueueStatusLogic(userId: number) {
  return getQueueStatus(userId);
}

export async function rescanPhotosLogic(userId: number, force: boolean): Promise<{ queued: number }> {
  const queued = await requeueForRescan(userId, force);
  triggerWorkers();
  return { queued };
}

export async function retryFailedScansLogic(userId: number): Promise<{ retried: number }> {
  const retried = await requeueFailed(userId);
  // Also retry any failed library-scan jobs so the "Fehler wiederholen"
  // button in Datenverwaltung covers the whole status table.
  const retriedLib = await requeueFailedLibraryScans();
  triggerWorkers();
  return { retried: retried + retriedLib };
}

export async function cancelPendingScansLogic(userId: number): Promise<{ cancelled: number }> {
  const cancelled = await cancelPendingScans(userId);
  const cancelledLib = await cancelPendingLibraryScans();
  return { cancelled: cancelled + cancelledLib };
}

/**
 * Recompute auto_crop for all photos of a user based on existing face/landmark data.
 */
export async function recomputeAllAutoCropsLogic(userId: number): Promise<{ updated: number }> {
  const allPhotos = await dbAll<{ id: number }>(
    db.select({ id: photos.id }).from(photos).where(eq(photos.user_id, userId))
  );

  let updated = 0;
  for (const p of allPhotos) {
    try {
      await computeAndStoreAutoCrop(userId, p.id);
      updated++;
    } catch (err) {
      console.error(`Error computing auto-crop for photo ${p.id}:`, err);
    }
  }

  return { updated };
}

// ── Orphaned person cleanup ──────────────────────────────────────────────────

/**
 * Remove persons that have no associated faces (orphaned after re-indexing).
 */
export async function cleanupOrphanedPersons(userId: number): Promise<void> {
  const deleted = await dbExec(
    db.delete(persons)
      .where(
        and(
          eq(persons.user_id, userId),
          sql`NOT EXISTS (SELECT 1 FROM user_face_assignments WHERE user_face_assignments.person_id = persons.id)`
        )
      )
  );
  console.log(`Cleaned up ${deleted.changes} orphaned persons for user ${userId}`);
}

// ========== Photo Groups (Clustering) ==========

const SIMILARITY_THRESHOLD = 0.90;
const TIME_WINDOW_SECONDS = 10 * 60; // 10 minutes
/**
 * Quiet window after a regroup pass before the coalesced follow-up fires.
 * Bulk scans finish hundreds of embedding jobs in quick succession, each
 * triggering `scheduleRegroup`. Without a debounce the mutex chains back-to-
 * back full rebuilds. Sleeping here lets the pending flag accumulate all
 * completions that arrive in the window so the next pass sees the final
 * state and runs once, not hundreds of times.
 */
const REGROUP_DEBOUNCE_MS = 30_000;

// Serialize similar-photo regrouping per user.
// `findPhotoGroupsLogic` reads the user's accessible photos, deletes all
// un-reviewed groups and re-inserts them. Concurrent runs for the same user
// (e.g. triggered by rapid album-photo adds) race on the delete/insert and
// can wipe out groups a parallel run just created. This scheduler guarantees:
//   - At most one run per user is in flight.
//   - Triggers arriving during a run are collapsed into exactly one follow-up
//     run that sees the latest state.
const groupingRunning = new Map<number, Promise<void>>();
const groupingPending = new Set<number>();

/**
 * Runs `findPhotoGroupsLogic(userId)` with a per-user mutex + coalescing:
 *   - If no run is active, starts one immediately.
 *   - If one is active, marks a follow-up and returns the in-flight promise,
 *     which only resolves after the follow-up pass completes.
 * The returned promise lets awaiters (e.g. the manual POST endpoint) block
 * until the regroup they asked for has actually happened.
 */
export function scheduleRegroup(userId: number): Promise<void> {
  const existing = groupingRunning.get(userId);
  if (existing) {
    groupingPending.add(userId);
    return existing;
  }
  const run = (async () => {
    try {
      do {
        groupingPending.delete(userId);
        // Back off when the event loop is already lagging. Regroup is a
        // pure-CPU O(N²) pass that would prolong the stall; latency-sensitive
        // requests (health checks, gallery hydration) should drain first.
        // Bounded so the pass still eventually runs on a permanently busy
        // server — otherwise regroup could starve indefinitely.
        let wait = 0;
        while (isUnderPressure() && wait < 30_000) {
          await new Promise((r) => setTimeout(r, 500));
          wait += 500;
        }
        try {
          await findPhotoGroupsLogic(userId);
        } catch (err) {
          console.error(`[regroup] error for user ${userId}:`, err);
        }
        // Debounce: wait a quiet window before running the follow-up pass so
        // bursts of trigger events (e.g. every scan-worker embedding job during
        // a bulk scan) coalesce into a single rebuild instead of chaining
        // back-to-back O(N²) loops.
        if (groupingPending.has(userId)) {
          await new Promise((r) => setTimeout(r, REGROUP_DEBOUNCE_MS));
        }
      } while (groupingPending.has(userId));
    } finally {
      groupingRunning.delete(userId);
    }
  })();
  groupingRunning.set(userId, run);
  return run;
}

export async function findPhotoGroupsLogic(userId: number): Promise<FindGroupsResponse> {
  // 1. Get all user photos with timestamps (own + shared album photos)
  const ownPhotos = await dbAll<{ id: number; taken_at: string | null; created_at: string | null }>(
    db.select({ id: photos.id, taken_at: photos.taken_at, created_at: photos.created_at })
      .from(photos)
      .where(eq(photos.user_id, userId))
  );

  // Also get photos visible through shared albums
  const sharedPhotos = await dbAll<{ id: number; taken_at: string | null; created_at: string | null }>(
    db.selectDistinct({ id: photos.id, taken_at: photos.taken_at, created_at: photos.created_at })
      .from(photos)
      .innerJoin(albumPhotos, eq(albumPhotos.photo_id, photos.id))
      .innerJoin(albumShares, and(
        eq(albumShares.album_id, albumPhotos.album_id),
        eq(albumShares.user_id, userId)
      ))
  );

  // Merge and deduplicate by photo ID
  const photoMap = new Map<number, { id: number; taken_at: string | null; created_at: string | null }>();
  for (const p of ownPhotos) photoMap.set(p.id, p);
  for (const p of sharedPhotos) {
    if (!photoMap.has(p.id)) photoMap.set(p.id, p);
  }
  const allPhotos = Array.from(photoMap.values());

  if (allPhotos.length < 2) {
    return { groups_created: 0, total_photos_grouped: 0 };
  }

  // 2. Offload the windowed pair scan + clustering to the embedding service.
  //
  // The old flow fetched every embedding (~140 MB for 45k photos), then ran a
  // 768-dim O(N²) cosine loop in JS. That blocked the Node event loop for
  // seconds at a time and stalled every gallery request issued during a
  // regroup. /similar-groups runs the same algorithm against pgvector-stored
  // embeddings using numpy SIMD matmul — embeddings never cross the HTTP
  // boundary, the computation happens in a separate process, and Node only
  // receives the final group structures.
  const photoIds = allPhotos.map((p) => p.id.toString());
  let remoteGroups: Array<{ cover_photo_id: string; members: Array<{ photo_id: string; similarity_rank: number }> }>;
  try {
    const response = await fetchWithTimeout(`${EMBEDDING_SERVICE_URL}/similar-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        photo_ids: photoIds,
        threshold: SIMILARITY_THRESHOLD,
        time_window_seconds: TIME_WINDOW_SECONDS,
      }),
    });
    if (!response.ok) throw new Error(`Embedding service returned ${response.status}`);
    const data = await response.json() as {
      groups: Array<{ cover_photo_id: string; members: Array<{ photo_id: string; similarity_rank: number }> }>;
    };
    remoteGroups = data.groups;
  } catch (err: any) {
    console.error("Failed to fetch similar groups:", err.message);
    throw new Error("Embedding service unavailable");
  }

  // Parse IDs once; guard against members the service returned that we don't
  // actually own (shouldn't happen — we sent the filtered set — but keeps us
  // honest against future schema drift).
  const accessibleIds = new Set(allPhotos.map((p) => p.id));
  const groups = remoteGroups
    .map((g) => ({
      coverPhotoId: parseInt(g.cover_photo_id, 10),
      members: g.members
        .map((m) => ({ photoId: parseInt(m.photo_id, 10), rank: m.similarity_rank }))
        .filter((m) => accessibleIds.has(m.photoId))
        .sort((a, b) => a.rank - b.rank),
    }))
    .filter((g) => g.members.length >= 2 && accessibleIds.has(g.coverPhotoId));

  // 3. Load reviewed groups so we can preserve / expire them against the new set.
  const reviewedGroups = await dbAll<{ id: number }>(
    db.select({ id: photoGroups.id })
      .from(photoGroups)
      .where(and(eq(photoGroups.user_id, userId), sql`${photoGroups.reviewed_at} IS NOT NULL`))
  );
  const reviewedIds = new Set(reviewedGroups.map((g) => g.id));

  const reviewedMemberSets = new Map<number, Set<number>>();
  for (const gid of reviewedIds) {
    const members = await dbAll<{ photo_id: number }>(
      db.select({ photo_id: photoGroupMembers.photo_id })
        .from(photoGroupMembers)
        .where(eq(photoGroupMembers.group_id, gid))
    );
    reviewedMemberSets.set(gid, new Set(members.map((m) => m.photo_id)));
  }

  // 4. Delete un-reviewed groups and insert new ones atomically. A single
  // transaction prevents concurrent runs from racing on the delete/insert.
  const doGroupingWork = async (tx: typeof db | any) => {
    await dbExec(
      tx.delete(photoGroups)
        .where(and(eq(photoGroups.user_id, userId), sql`${photoGroups.reviewed_at} IS NULL`))
    );

    let created = 0;
    let grouped = 0;

    for (const group of groups) {
      const memberSet = new Set(group.members.map((m) => m.photoId));

      let alreadyReviewed = false;
      const obsoleteReviewedIds: number[] = [];
      for (const [gid, reviewedSet] of reviewedMemberSets) {
        if (memberSet.size === reviewedSet.size && [...memberSet].every((id) => reviewedSet.has(id))) {
          alreadyReviewed = true;
          break;
        }
        // New group is a strict superset of a reviewed one — the reviewed
        // snapshot is obsolete (e.g. a photo was added to a shared album and
        // the group grew). Mark the old reviewed row for deletion so the user
        // can re-review the expanded group once.
        if (reviewedSet.size < memberSet.size && [...reviewedSet].every((id) => memberSet.has(id))) {
          obsoleteReviewedIds.push(gid);
        }
      }
      if (alreadyReviewed) continue;

      if (obsoleteReviewedIds.length > 0) {
        await dbExec(
          tx.delete(photoGroups).where(inArray(photoGroups.id, obsoleteReviewedIds))
        );
        for (const gid of obsoleteReviewedIds) reviewedMemberSets.delete(gid);
      }

      const inserted = await dbInsertReturning<{ id: number }>(
        tx.insert(photoGroups)
          .values({ user_id: userId, cover_photo_id: group.coverPhotoId })
          .returning({ id: photoGroups.id })
      );

      for (const member of group.members) {
        await dbExec(
          tx.insert(photoGroupMembers).values({
            group_id: inserted!.id,
            photo_id: member.photoId,
            similarity_rank: member.rank,
          })
        );
      }

      created++;
      grouped += group.members.length;
    }

    return { created, grouped };
  };

  const isPg = process.env.DB_TYPE?.toLowerCase() === 'postgres';
  const { created: groupsCreated, grouped: totalPhotosGrouped } = isPg
    ? await (db as any).transaction(doGroupingWork)
    : await doGroupingWork(db);

  console.log(`Photo grouping for user ${userId}: ${groupsCreated} groups created, ${totalPhotosGrouped} photos grouped`);
  return { groups_created: groupsCreated, total_photos_grouped: totalPhotosGrouped };
}

/**
 * Summary of the current grouping state for a user. Used by the manual
 * POST /photos/find-groups endpoint after scheduleRegroup() resolves, since
 * the scheduler doesn't surface the last run's counts directly.
 */
export async function countUserGroupStats(userId: number): Promise<FindGroupsResponse> {
  const rows = await dbAll<{ group_count: number; member_count: number }>(
    db.select({
      group_count: sql<number>`COUNT(DISTINCT ${photoGroups.id})`.as('group_count'),
      member_count: sql<number>`COUNT(${photoGroupMembers.photo_id})`.as('member_count'),
    })
      .from(photoGroups)
      .leftJoin(photoGroupMembers, eq(photoGroupMembers.group_id, photoGroups.id))
      .where(eq(photoGroups.user_id, userId))
  );
  const stats = rows[0] ?? { group_count: 0, member_count: 0 };
  return {
    groups_created: Number(stats.group_count) || 0,
    total_photos_grouped: Number(stats.member_count) || 0,
  };
}

export async function listPhotoGroupsLogic(userId: number): Promise<ListGroupsResponse> {
  const groups = await dbAll<{
    id: number; user_id: number; cover_photo_id: number | null;
    reviewed_at: string | null; created_at: string | null;
  }>(
    db
      .select({
        id: photoGroups.id,
        user_id: photoGroups.user_id,
        cover_photo_id: photoGroups.cover_photo_id,
        reviewed_at: photoGroups.reviewed_at,
        created_at: photoGroups.created_at,
      })
      .from(photoGroups)
      .where(eq(photoGroups.user_id, userId))
      .orderBy(photoGroups.created_at)
  );

  const result: PhotoGroup[] = [];
  for (const g of groups) {
    const members = await dbAll<{ photo_id: number }>(
      db.select({ photo_id: photoGroupMembers.photo_id })
        .from(photoGroupMembers)
        .where(eq(photoGroupMembers.group_id, g.id))
        .orderBy(photoGroupMembers.similarity_rank)
    );

    result.push({
      id: g.id,
      user_id: g.user_id,
      cover_photo_id: g.cover_photo_id ?? undefined,
      reviewed_at: g.reviewed_at ?? undefined,
      created_at: g.created_at ?? "",
      member_count: members.length,
      photo_ids: members.map((m) => m.photo_id),
    });
  }

  return { groups: result };
}

export async function getNextUnreviewedGroupLogic(userId: number): Promise<PhotoGroup | null> {
  const group = await dbFirst<{
    id: number; user_id: number; cover_photo_id: number | null;
    reviewed_at: string | null; created_at: string | null;
  }>(
    db
      .select({
        id: photoGroups.id,
        user_id: photoGroups.user_id,
        cover_photo_id: photoGroups.cover_photo_id,
        reviewed_at: photoGroups.reviewed_at,
        created_at: photoGroups.created_at,
      })
      .from(photoGroups)
      .where(and(eq(photoGroups.user_id, userId), sql`${photoGroups.reviewed_at} IS NULL`))
      .orderBy(photoGroups.created_at)
      .limit(1)
  );

  if (!group) return null;

  const members = await dbAll<{ photo_id: number }>(
    db.select({ photo_id: photoGroupMembers.photo_id })
      .from(photoGroupMembers)
      .where(eq(photoGroupMembers.group_id, group.id))
      .orderBy(photoGroupMembers.similarity_rank)
  );

  return {
    id: group.id,
    user_id: group.user_id,
    cover_photo_id: group.cover_photo_id ?? undefined,
    reviewed_at: undefined,
    created_at: group.created_at ?? "",
    member_count: members.length,
    photo_ids: members.map((m) => m.photo_id),
  };
}

export async function reviewPhotoGroupLogic(
  userId: number,
  groupId: number,
  photoIds?: number[]
): Promise<{ success: boolean }> {
  const group = await dbFirst<{ id: number }>(
    db.select({ id: photoGroups.id })
      .from(photoGroups)
      .where(and(eq(photoGroups.id, groupId), eq(photoGroups.user_id, userId)))
  );

  // Stale ID: background regrouping (scheduleRegroup) deletes all unreviewed
  // groups and recreates them with fresh IDs. If the frontend sent photo_ids,
  // try to find the current unreviewed group that has exactly the same members
  // and mark that one as reviewed instead.
  if (!group && photoIds && photoIds.length > 0) {
    const candidates = await dbAll<{ id: number }>(
      db.select({ id: photoGroups.id })
        .from(photoGroups)
        .where(and(
          eq(photoGroups.user_id, userId),
          isNull(photoGroups.reviewed_at)
        ))
    );

    for (const candidate of candidates) {
      const members = await dbAll<{ photo_id: number }>(
        db.select({ photo_id: photoGroupMembers.photo_id })
          .from(photoGroupMembers)
          .where(eq(photoGroupMembers.group_id, candidate.id))
      );
      const memberIds = new Set(members.map((m) => m.photo_id));
      if (
        memberIds.size === photoIds.length &&
        photoIds.every((id) => memberIds.has(id))
      ) {
        await dbExec(
          db.update(photoGroups)
            .set({ reviewed_at: new Date().toISOString() })
            .where(eq(photoGroups.id, candidate.id))
        );
        return { success: true };
      }
    }
  }

  // If nothing matches, treat the request as idempotent: the group is either
  // already reviewed or was removed by regrouping. Returning success avoids
  // an internal error in the UI when the client holds a stale group ID.
  if (!group) return { success: true };

  await dbExec(
    db.update(photoGroups)
      .set({ reviewed_at: new Date().toISOString() })
      .where(eq(photoGroups.id, groupId))
  );

  return { success: true };
}

export interface PhotoSearchResult {
  photoId: number;
  score: number;
  filename: string;
  taken_at?: string;
  created_at: string;
}

export async function searchPhotosLogic(
  userId: number,
  query: string,
  limit: number = 20,
  threshold: number = 0.20
): Promise<{ photos: PhotoWithCuration[] }> {
  // 0. Check if query matches a known person name
  const matchedPerson = await dbFirst<{ id: number }>(
    db.select({ id: persons.id })
      .from(persons)
      .where(and(eq(persons.user_id, userId), ilike(persons.name, `%${query}%`)))
      .limit(1)
  );

  if (matchedPerson) {
    const personFaces = await dbAll<{ photo_id: number }>(
      db.select({ photo_id: faces.photo_id })
        .from(userFaceAssignments)
        .innerJoin(faces, eq(faces.id, userFaceAssignments.face_id))
        .where(and(
          eq(userFaceAssignments.user_id, userId),
          eq(userFaceAssignments.person_id, matchedPerson.id),
          eq(userFaceAssignments.ignored, false)
        ))
    );
    const uniquePhotoIds = [...new Set(personFaces.map(f => f.photo_id))];
    if (uniquePhotoIds.length === 0) return { photos: [] };

    const rows = await dbAll<{
      id: number; user_id: number; filename: string; original_name: string;
      mime_type: string; size: number; hash: string | null; taken_at: string | null;
      created_at: string | null; curation_status: string | null;
      latitude: number | null; longitude: number | null;
      location_city: string | null; location_country: string | null; location_name: string | null;
      location_short: string | null; auto_crop: { x: number; y: number } | null;
    }>(
      db.select({
        id: photos.id, user_id: photos.user_id, filename: photos.filename,
        original_name: photos.original_name, mime_type: photos.mime_type,
        size: photos.size, hash: photos.hash, taken_at: photos.taken_at,
        created_at: photos.created_at, curation_status: photoCuration.status,
        latitude: photos.latitude, longitude: photos.longitude,
        location_city: photos.location_city, location_country: photos.location_country,
        location_name: photos.location_name, location_short: photos.location_short, auto_crop: photos.auto_crop,
      })
      .from(photos)
      .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
      .where(and(eq(photos.user_id, userId), inArray(photos.id, uniquePhotoIds)))
    );
    return {
      photos: rows.map(r => ({
        id: r.id, user_id: r.user_id, filename: r.filename, original_name: r.original_name,
        mime_type: r.mime_type, size: r.size, hash: r.hash ?? undefined,
        taken_at: r.taken_at ?? undefined, created_at: r.created_at ?? "",
        curation_status: (r.curation_status as CurationStatus) ?? "visible",
        latitude: r.latitude ?? undefined, longitude: r.longitude ?? undefined,
        location_city: r.location_city ?? undefined, location_country: r.location_country ?? undefined,
        location_name: r.location_name ?? undefined, location_short: r.location_short ?? undefined,
        auto_crop: r.auto_crop ?? undefined,
      })),
    };
  }

  // 1. Call embedding service text search
  let embeddingResults: Array<{ photo_id: string; score: number }>;
  try {
    const response = await fetchWithTimeout(`${EMBEDDING_SERVICE_URL}/search/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: query.slice(0, EMBEDDING_TEXT_SEARCH_MAX_QUERY_LEN),
        k: Math.min(limit, EMBEDDING_TEXT_SEARCH_MAX_K),
        threshold,
      }),
      // Search is on the request path — keep the timeout short so a stalled
      // embedding service doesn't hold up the UI spinner indefinitely.
      timeoutMs: ML_RPC_QUICK_TIMEOUT_MS,
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Embedding service returned ${response.status}: ${errText}`);
    }
    const data = await response.json() as { results: Array<{ photo_id: string; score: number }> };
    embeddingResults = data.results;
  } catch (err) {
    console.error("Text search via embedding service failed:", err);
    throw err;
  }

  if (embeddingResults.length === 0) {
    return { photos: [] };
  }

  // 2. Map numeric photo IDs and verify ownership
  const photoIdNumbers = embeddingResults
    .map(r => parseInt(r.photo_id, 10))
    .filter(id => !isNaN(id));

  const rows = await dbAll<{
    id: number; user_id: number; filename: string; original_name: string;
    mime_type: string; size: number; hash: string | null; taken_at: string | null;
    created_at: string | null; curation_status: string | null;
    latitude: number | null; longitude: number | null;
    location_city: string | null; location_country: string | null; location_name: string | null;
    location_short: string | null; auto_crop: { x: number; y: number } | null;
  }>(
    db.select({
      id: photos.id, user_id: photos.user_id, filename: photos.filename,
      original_name: photos.original_name, mime_type: photos.mime_type,
      size: photos.size, hash: photos.hash, taken_at: photos.taken_at,
      created_at: photos.created_at, curation_status: photoCuration.status,
      latitude: photos.latitude, longitude: photos.longitude,
      location_city: photos.location_city, location_country: photos.location_country,
      location_name: photos.location_name, location_short: photos.location_short, auto_crop: photos.auto_crop,
    })
    .from(photos)
    .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
    .where(and(eq(photos.user_id, userId), inArray(photos.id, photoIdNumbers)))
  );

  const photoMap = new Map(rows.map(r => [r.id, r]));

  // 3. Build results preserving embedding score order
  const resultPhotos: PhotoWithCuration[] = [];
  for (const r of embeddingResults) {
    const id = parseInt(r.photo_id, 10);
    const row = photoMap.get(id);
    if (!row) continue; // skip photos not belonging to user
    resultPhotos.push({
      id: row.id, user_id: row.user_id, filename: row.filename, original_name: row.original_name,
      mime_type: row.mime_type, size: row.size, hash: row.hash ?? undefined,
      taken_at: row.taken_at ?? undefined, created_at: row.created_at ?? "",
      curation_status: (row.curation_status as CurationStatus) ?? "visible",
      latitude: row.latitude ?? undefined, longitude: row.longitude ?? undefined,
      location_city: row.location_city ?? undefined, location_country: row.location_country ?? undefined,
      location_name: row.location_name ?? undefined, location_short: row.location_short ?? undefined,
      auto_crop: row.auto_crop ?? undefined,
    });
  }

  return { photos: resultPhotos };
}

// ---------- Photo Timeline ----------

export interface TimelineMonth {
  month: number;
  count: number;
  cover_filename: string | null;
}

export interface TimelineYear {
  year: number;
  count: number;
  cover_filename: string | null;
  months: TimelineMonth[];
}

export interface PhotoTimelineResponse {
  years: TimelineYear[];
}

export async function getPhotoTimelineLogic(userId: number): Promise<PhotoTimelineResponse> {
  // Get month-level counts + cover filename (newest photo per month) in one query
  const rows = (await db.execute(sql`
    WITH visible AS (
      SELECT
        p.filename,
        EXTRACT(YEAR  FROM COALESCE(p.taken_at, p.created_at))::int AS year,
        EXTRACT(MONTH FROM COALESCE(p.taken_at, p.created_at))::int AS month,
        COALESCE(p.taken_at, p.created_at) AS photo_date
      FROM photos p
      LEFT JOIN photo_curation pc ON pc.photo_id = p.id AND pc.user_id = ${userId}
      WHERE p.user_id = ${userId}
        AND (pc.status IS NULL OR pc.status != 'hidden')
    ),
    covers AS (
      SELECT DISTINCT ON (year, month) year, month, filename AS cover_filename
      FROM visible
      ORDER BY year, month, photo_date DESC
    ),
    counts AS (
      SELECT year, month, COUNT(*)::int AS count
      FROM visible
      GROUP BY year, month
    )
    SELECT c.year, c.month, c.count, cv.cover_filename
    FROM counts c
    JOIN covers cv ON cv.year = c.year AND cv.month = c.month
    ORDER BY c.year DESC, c.month DESC
  `)).rows as Array<{ year: number; month: number; count: number; cover_filename: string | null }>;

  // Group months under years
  const yearMap = new Map<number, TimelineYear>();
  for (const row of rows) {
    if (!yearMap.has(row.year)) {
      yearMap.set(row.year, {
        year: Number(row.year),
        count: 0,
        cover_filename: row.cover_filename,
        months: [],
      });
    }
    const yr = yearMap.get(row.year)!;
    const count = Number(row.count);
    yr.count += count;
    yr.months.push({ month: Number(row.month), count, cover_filename: row.cover_filename });
  }

  return { years: Array.from(yearMap.values()) };
}

// ---------- Date Range Search ----------

export async function searchByDateRangeLogic(
  userId: number,
  params: { from?: string; to?: string; year?: number; month?: number; limit?: number }
): Promise<{ photos: PhotoWithCuration[] }> {
  let fromDate: Date | undefined;
  let toDate: Date | undefined;

  if (params.from) fromDate = new Date(params.from);
  if (params.to) toDate = new Date(params.to);

  if (params.year !== undefined && !params.from) {
    if (params.month !== undefined) {
      fromDate = new Date(params.year, params.month - 1, 1);
      toDate = new Date(params.year, params.month, 0, 23, 59, 59, 999);
    } else {
      fromDate = new Date(`${params.year}-01-01T00:00:00`);
      toDate = new Date(`${params.year}-12-31T23:59:59`);
    }
  }

  const conditions: ReturnType<typeof and>[] = [
    eq(photos.user_id, userId),
    or(sql`${photoCuration.status} IS NULL`, sql`${photoCuration.status} != 'hidden'`),
  ];
  if (fromDate) {
    conditions.push(sql`COALESCE(${photos.taken_at}, ${photos.created_at}) >= ${fromDate.toISOString()}`);
  }
  if (toDate) {
    conditions.push(sql`COALESCE(${photos.taken_at}, ${photos.created_at}) <= ${toDate.toISOString()}`);
  }

  const rows = await dbAll<{
    id: number; user_id: number; filename: string; original_name: string;
    mime_type: string; size: number; hash: string | null; taken_at: string | null;
    created_at: string | null; curation_status: string | null;
    latitude: number | null; longitude: number | null;
    location_city: string | null; location_country: string | null; location_name: string | null;
    location_short: string | null; auto_crop: { x: number; y: number } | null;
  }>(
    db.select({
      id: photos.id, user_id: photos.user_id, filename: photos.filename,
      original_name: photos.original_name, mime_type: photos.mime_type,
      size: photos.size, hash: photos.hash, taken_at: photos.taken_at,
      created_at: photos.created_at, curation_status: photoCuration.status,
      latitude: photos.latitude, longitude: photos.longitude,
      location_city: photos.location_city, location_country: photos.location_country,
      location_name: photos.location_name, location_short: photos.location_short, auto_crop: photos.auto_crop,
    })
    .from(photos)
    .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
    .where(and(...conditions))
    .orderBy(photoDateOrder)
    .limit(params.limit ?? 500)
  );

  return {
    photos: rows.map(r => ({
      id: r.id, user_id: r.user_id, filename: r.filename, original_name: r.original_name,
      mime_type: r.mime_type, size: r.size, hash: r.hash ?? undefined,
      taken_at: r.taken_at ?? undefined, created_at: r.created_at ?? "",
      curation_status: (r.curation_status as CurationStatus) ?? "visible",
      latitude: r.latitude ?? undefined, longitude: r.longitude ?? undefined,
      location_city: r.location_city ?? undefined, location_country: r.location_country ?? undefined,
      location_name: r.location_name ?? undefined, location_short: r.location_short ?? undefined, auto_crop: r.auto_crop ?? undefined,
    })),
  };
}

// ---------- Location Search ----------

export async function searchByLocationLogic(
  userId: number,
  params: { city?: string; country?: string; lat?: number; lon?: number; radius?: number; limit?: number }
): Promise<{ photos: PhotoWithCuration[] }> {
  const conditions: ReturnType<typeof and>[] = [
    eq(photos.user_id, userId),
    or(sql`${photoCuration.status} IS NULL`, sql`${photoCuration.status} != 'hidden'`),
  ];

  if (params.city) {
    conditions.push(ilike(photos.location_city, `%${params.city}%`));
  }
  if (params.country) {
    conditions.push(ilike(photos.location_country, `%${params.country}%`));
  }
  if (params.lat !== undefined && params.lon !== undefined) {
    const radius = params.radius ?? 10;
    // Bounding box pre-filter (Haversine-Näherung)
    const latDelta = radius / 111.0;
    const lonDelta = radius / (111.0 * Math.cos(params.lat * Math.PI / 180));
    conditions.push(sql`${photos.latitude} IS NOT NULL`);
    conditions.push(sql`${photos.latitude} BETWEEN ${params.lat - latDelta} AND ${params.lat + latDelta}`);
    conditions.push(sql`${photos.longitude} BETWEEN ${params.lon - lonDelta} AND ${params.lon + lonDelta}`);
  }

  const rows = await dbAll<{
    id: number; user_id: number; filename: string; original_name: string;
    mime_type: string; size: number; hash: string | null; taken_at: string | null;
    created_at: string | null; curation_status: string | null;
    latitude: number | null; longitude: number | null;
    location_city: string | null; location_country: string | null; location_name: string | null;
    location_short: string | null; auto_crop: { x: number; y: number } | null;
  }>(
    db.select({
      id: photos.id, user_id: photos.user_id, filename: photos.filename,
      original_name: photos.original_name, mime_type: photos.mime_type,
      size: photos.size, hash: photos.hash, taken_at: photos.taken_at,
      created_at: photos.created_at, curation_status: photoCuration.status,
      latitude: photos.latitude, longitude: photos.longitude,
      location_city: photos.location_city, location_country: photos.location_country,
      location_name: photos.location_name, location_short: photos.location_short, auto_crop: photos.auto_crop,
    })
    .from(photos)
    .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
    .where(and(...conditions))
    .orderBy(photoDateOrder)
    .limit(params.limit ?? 500)
  );

  return {
    photos: rows.map(r => ({
      id: r.id, user_id: r.user_id, filename: r.filename, original_name: r.original_name,
      mime_type: r.mime_type, size: r.size, hash: r.hash ?? undefined,
      taken_at: r.taken_at ?? undefined, created_at: r.created_at ?? "",
      curation_status: (r.curation_status as CurationStatus) ?? "visible",
      latitude: r.latitude ?? undefined, longitude: r.longitude ?? undefined,
      location_city: r.location_city ?? undefined, location_country: r.location_country ?? undefined,
      location_name: r.location_name ?? undefined, location_short: r.location_short ?? undefined, auto_crop: r.auto_crop ?? undefined,
    })),
  };
}

// ---------- Landmark Detection & Search ----------

export interface LandmarkItem {
  id: number;
  label: string;
  confidence: number;
  bbox: LandmarkBBox;
}

export interface LandmarkSearchResult {
  photoId: number;
  filename: string;
  taken_at?: string;
  created_at: string;
  landmarks: Array<{ label: string; confidence: number; bbox: LandmarkBBox }>;
}

async function callLandmarkService(
  filePath: string
): Promise<{ landmarks: Array<{ label: string; confidence: number; bbox: { x: number; y: number; width: number; height: number } }> }> {
  const formData = new FormData();
  const fileData = await fs.promises.readFile(filePath);
  const blob = new Blob([fileData], { type: getUploadMimeType(filePath) });
  formData.append("file", blob, path.basename(filePath));

  const response = await fetchWithTimeout(`${LANDMARK_SERVICE_URL}/detect-landmarks`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Landmark service returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<{ landmarks: Array<{ label: string; confidence: number; bbox: { x: number; y: number; width: number; height: number } }> }>;
}

/**
 * Detect landmarks in a photo (global, runs once per photo).
 * userId is only used for auto-crop recomputation.
 */
export async function indexPhotoLandmarks(photoId: number): Promise<void> {
  if (!ENABLE_LANDMARKS) return;

  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(eq(photos.id, photoId))
  );
  if (!photo) return;

  const filePath = getPhotoDiskPath(photo);
  if (!fs.existsSync(filePath)) return;

  let processingPath = filePath;
  let tempPath: string | null = null;

  const ext = path.extname(photo.filename).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    try {
      const inputBuffer = await fs.promises.readFile(filePath);
      const outputBuffer = await heicConvert({ buffer: inputBuffer, format: "JPEG", quality: 1 });
      tempPath = path.join(UPLOAD_DIR, `temp_lm_${photoId}_${Date.now()}.jpg`);
      await fs.promises.writeFile(tempPath, outputBuffer as Buffer);
      processingPath = tempPath;
    } catch (err) {
      console.error(`HEIC conversion for landmark detection failed (photo ${photoId}):`, err);
      return;
    }
  }

  try {
    const result = await callLandmarkService(processingPath);
    // Only keep landmarks with ≥60% confidence to avoid cluttering the DB
    const confident = result.landmarks.filter(lm => lm.confidence >= 0.6);
    if (confident.length > 0) {
      await dbExec(db.delete(photoLandmarks).where(eq(photoLandmarks.photo_id, photoId)));
      for (const lm of confident) {
        await dbExec(
          db.insert(photoLandmarks).values({
            photo_id: photoId,
            label: lm.label,
            confidence: lm.confidence,
            bbox: JSON.stringify(lm.bbox),
          })
        );
      }
      console.log(`Stored ${confident.length} landmarks for photo ${photoId} (${result.landmarks.length - confident.length} below 60% filtered)`);
    } else if (result.landmarks.length > 0) {
      // All landmarks below threshold – clear any stale entries
      await dbExec(db.delete(photoLandmarks).where(eq(photoLandmarks.photo_id, photoId)));
    }
  } catch (err) {
    console.error(`Landmark detection failed for photo ${photoId}:`, err);
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }

  // Recompute auto-crop focus point (landmarks as fallback if no faces).
  // This is a global operation — use photo owner for the per-user face filter.
  try {
    const ownerId = await getPhotoOwnerId(photoId);
    if (ownerId) {
      await computeAndStoreAutoCrop(ownerId, photoId);
    }
  } catch (err) {
    console.error(`Error computing auto-crop for photo ${photoId}:`, err);
  }
}

// ---------- AI Quality Scoring ----------

interface FaceBBoxNorm { x: number; y: number; width: number; height: number }

/**
 * Score how well a set of detected face bounding boxes are composed within
 * the frame.  Returns a value in [0, 1], or null when no faces are present
 * (so the caller can omit the signal entirely rather than penalising photos
 * that have not yet been face-scanned or that intentionally contain no faces).
 *
 * Criteria:
 *  - Face size relative to the image (ideal 5–45 % of image area)
 *  - Proximity of the face centre to image edges (cropped faces score lower)
 */
/** Exported for testing. */
export function computeFaceCompositionScore(bboxes: FaceBBoxNorm[]): number | null {
  const visible = bboxes.filter(b => b.width > 0 && b.height > 0);
  if (visible.length === 0) return null;

  // Use the largest face as the main subject
  const main = visible.reduce((best, f) =>
    f.width * f.height > best.width * best.height ? f : best
  );

  const area = main.width * main.height;

  // Area score: ideal range 0.05–0.45 (5–45 % of image)
  let areaScore: number;
  if (area < 0.005) {
    areaScore = 0.2;                                              // very distant
  } else if (area < 0.05) {
    areaScore = 0.2 + ((area - 0.005) / 0.045) * 0.7;           // ramp up
  } else if (area <= 0.45) {
    areaScore = 0.9;                                              // ideal
  } else if (area <= 0.75) {
    areaScore = 0.9 - ((area - 0.45) / 0.30) * 0.4;             // ramp down (very close)
  } else {
    areaScore = 0.5;                                              // face fills most of frame
  }

  // Position score: penalise face centres that are very close to any edge
  const cx = main.x + main.width / 2;
  const cy = main.y + main.height / 2;
  const minEdgeDist = Math.min(cx, 1 - cx, cy, 1 - cy);
  // Full score if centre is >0.15 from any edge; zero at the edge
  const positionScore = Math.min(1.0, minEdgeDist / 0.15);

  return areaScore * 0.65 + positionScore * 0.35;
}

export async function indexPhotoQuality(photoId: number): Promise<void> {
  if (!ENABLE_QUALITY) return;

  // Face bbox data is fetched from the DB later and used for composition
  // scoring when available.  We no longer defer on pending face_detection jobs
  // because that blocks quality scanning entirely during "scan missing" when
  // both services are re-enqueued at the same time.

  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(eq(photos.id, photoId))
  );
  if (!photo) return;

  const filePath = getPhotoDiskPath(photo);
  if (!fs.existsSync(filePath)) return;

  let processingPath = filePath;
  let tempPath: string | null = null;

  // HEIC files must be converted before sending to the embedding service.
  // sharp's bundled libvips lacks HEIC decode support; use heic-convert instead.
  const ext = path.extname(photo.filename).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    try {
      const jpegBuffer = await convertHeicToJpeg(filePath);
      tempPath = path.join(UPLOAD_DIR, `temp_q_${photoId}_${Date.now()}.jpg`);
      await fs.promises.writeFile(tempPath, jpegBuffer);
      processingPath = tempPath;
    } catch (err) {
      console.error(`HEIC conversion for quality scoring failed (photo ${photoId}):`, err);
      return;
    }
  }

  // Query face bboxes upfront — used both for the quality API and composition scoring
  let bboxes: FaceBBoxNorm[] = [];
  try {
    const faceRows = await dbAll<{ bbox: string }>(
      db.select({ bbox: faces.bbox })
        .from(faces)
        .where(eq(faces.photo_id, photoId))
    );
    bboxes = faceRows.map(r => JSON.parse(r.bbox) as FaceBBoxNorm);
  } catch (faceErr) {
    console.warn(`[quality] face bbox query failed for photo ${photoId}:`, faceErr);
  }

  try {
    const formData = new FormData();
    const fileData = await fs.promises.readFile(processingPath);
    const blob = new Blob([fileData], { type: getUploadMimeType(processingPath) });
    formData.append("file", blob, path.basename(processingPath));
    if (bboxes.length > 0) {
      formData.append("face_bboxes", JSON.stringify(bboxes));
    }

    const response = await fetchWithTimeout(`${EMBEDDING_SERVICE_URL}/quality`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Quality service returned ${response.status} for photo ${photoId}: ${errorText}`);
    }

    const result = await response.json() as {
      score: number;
      blur_score?: number;
      contrast_score?: number;
      exposure_score?: number;
      clip_aesthetics?: number;
      clip_composition?: number;
      clip_technical?: number;
      face_sharpness?: number;
      eyes_open_score?: number;
    };
    let compositeScore = result.score;
    const details: Record<string, number> = {};
    if (result.blur_score !== undefined) details.sharpness = Math.round(result.blur_score * 100) / 100;
    if (result.contrast_score !== undefined) details.contrast = Math.round(result.contrast_score * 100) / 100;
    if (result.exposure_score !== undefined) details.exposure = Math.round(result.exposure_score * 100) / 100;
    if (result.clip_aesthetics !== undefined) details.clip_aesthetics = Math.round(result.clip_aesthetics * 100) / 100;
    if (result.clip_composition !== undefined) details.clip_composition = Math.round(result.clip_composition * 100) / 100;
    if (result.clip_technical !== undefined) details.clip_technical = Math.round(result.clip_technical * 100) / 100;
    if (result.face_sharpness !== undefined) {
      details.face_sharpness = Math.round(result.face_sharpness * 100) / 100;
      console.log(`[quality] photo ${photoId} face_sharpness=${result.face_sharpness.toFixed(3)}`);
    }
    if (result.eyes_open_score !== undefined) {
      details.eyes_open = Math.round(result.eyes_open_score * 100) / 100;
      console.log(`[quality] photo ${photoId} eyes_open_score=${result.eyes_open_score.toFixed(3)}`);
    }

    // ── Face composition signal (position + area) ──────────────────────────
    try {
      const faceScore = computeFaceCompositionScore(bboxes);
      if (faceScore !== null) {
        details.face_composition = Math.round(faceScore * 100) / 100;
        compositeScore = compositeScore * 0.85 + faceScore * 0.15;
        console.log(`[quality] photo ${photoId} face composition score ${faceScore.toFixed(3)} → blended ${compositeScore.toFixed(3)}`);
      }
    } catch (faceErr) {
      console.warn(`[quality] face composition scoring failed for photo ${photoId}:`, faceErr);
    }

    await db
      .update(photos)
      .set({
        ai_quality_score: compositeScore,
        ai_quality_details: Object.keys(details).length > 0 ? details : null,
      })
      .where(eq(photos.id, photoId));

    console.log(`[quality] photo ${photoId} final score ${compositeScore.toFixed(3)}`);

    // ── Virtual AI curation vote ──────────────────────────────────────────
    const aiUserId = await getAiUserId();
    if (aiUserId) {
      let aiStatus: CurationStatus = "visible";
      if (compositeScore >= AI_FAV_THRESHOLD) aiStatus = "favorite";
      else if (compositeScore <= AI_HIDE_THRESHOLD) aiStatus = "hidden";

      await db
        .insert(photoCuration)
        .values({ user_id: aiUserId, photo_id: photoId, status: aiStatus })
        .onConflictDoUpdate({
          target: [photoCuration.user_id, photoCuration.photo_id],
          set: { status: aiStatus, updated_at: nowSql },
        });
      console.log(`[quality] photo ${photoId} AI curation → ${aiStatus} (score=${compositeScore.toFixed(3)}, thresholds: fav>=${AI_FAV_THRESHOLD}, hide<=${AI_HIDE_THRESHOLD})`);
    }
  } catch (err) {
    console.error(`Quality scoring failed for photo ${photoId}:`, err);
    throw err;
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

export interface PhotoLocation {
  name?: string;
  city?: string;
  country?: string;
}

export async function getLandmarksForPhotoLogic(
  userId: number,
  photoId: number
): Promise<{ landmarks: LandmarkItem[]; location?: PhotoLocation }> {
  // Allow access for photo owner OR users with shared album access
  const photo = await dbFirst<{ id: number; location_name: string | null; location_city: string | null; location_country: string | null }>(
    db.select({ id: photos.id, location_name: photos.location_name, location_city: photos.location_city, location_country: photos.location_country })
      .from(photos)
      .where(eq(photos.id, photoId))
  );
  if (!photo) throw new Error("Photo not found");

  const accessibleUsers = await getUsersWithPhotoAccess(photoId);
  if (!accessibleUsers.includes(userId)) throw new Error("Photo not found");

  const rows = await dbAll<{ id: number; label: string; confidence: number; bbox: string }>(
    db.select({ id: photoLandmarks.id, label: photoLandmarks.label, confidence: photoLandmarks.confidence, bbox: photoLandmarks.bbox })
      .from(photoLandmarks)
      .where(eq(photoLandmarks.photo_id, photoId))
      .orderBy(sql`${photoLandmarks.confidence} DESC`)
  );

  const hasLocation = photo.location_name || photo.location_city || photo.location_country;

  return {
    landmarks: rows.map(r => ({
      id: r.id,
      label: r.label,
      confidence: r.confidence,
      bbox: JSON.parse(r.bbox) as LandmarkBBox,
    })),
    location: hasLocation ? {
      name: photo.location_name ?? undefined,
      city: photo.location_city ?? undefined,
      country: photo.location_country ?? undefined,
    } : undefined,
  };
}

export async function searchByLandmarkLogic(
  userId: number,
  query: string,
  limit: number = 50
): Promise<{ results: LandmarkSearchResult[] }> {
  // Join with photos to filter by user ownership (landmarks are global, access is per-user)
  const lmRows = await dbAll<{ photo_id: number; label: string; confidence: number; bbox: string }>(
    db.select({
      photo_id: photoLandmarks.photo_id,
      label: photoLandmarks.label,
      confidence: photoLandmarks.confidence,
      bbox: photoLandmarks.bbox,
    })
    .from(photoLandmarks)
    .innerJoin(photos, eq(photos.id, photoLandmarks.photo_id))
    .where(and(eq(photos.user_id, userId), ilike(photoLandmarks.label, `%${query}%`)))
    .orderBy(sql`${photoLandmarks.confidence} DESC`)
  );

  if (lmRows.length === 0) return { results: [] };

  const uniquePhotoIds = [...new Set(lmRows.map(r => r.photo_id))].slice(0, limit);
  const userPhotos = await dbAll<{ id: number; filename: string; taken_at: string | null; created_at: string | null }>(
    db.select({ id: photos.id, filename: photos.filename, taken_at: photos.taken_at, created_at: photos.created_at })
      .from(photos)
      .where(and(eq(photos.user_id, userId), inArray(photos.id, uniquePhotoIds)))
  );

  const photoMap = new Map(userPhotos.map(p => [p.id, p]));
  const grouped = new Map<number, typeof lmRows>();
  for (const lm of lmRows) {
    if (!grouped.has(lm.photo_id)) grouped.set(lm.photo_id, []);
    grouped.get(lm.photo_id)!.push(lm);
  }

  const results: LandmarkSearchResult[] = [];
  for (const photoId of uniquePhotoIds) {
    const photo = photoMap.get(photoId);
    if (!photo) continue;
    const landmarks = grouped.get(photoId) ?? [];
    results.push({
      photoId,
      filename: photo.filename,
      taken_at: photo.taken_at ?? undefined,
      created_at: photo.created_at ?? "",
      landmarks: landmarks.map(lm => ({
        label: lm.label,
        confidence: lm.confidence,
        bbox: JSON.parse(lm.bbox) as LandmarkBBox,
      })),
    });
  }

  return { results };
}

// ---------- Natural Language Query Parser ----------

const GERMAN_MONTHS: Record<string, number> = {
  januar: 1, jan: 1, jänner: 1,
  februar: 2, feb: 2,
  märz: 3, maerz: 3, mar: 3,
  april: 4, apr: 4,
  mai: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, oct: 10,
  november: 11, nov: 11,
  dezember: 12, dez: 12,
};

// Serializable form returned to API callers
export interface ParsedQuery {
  semanticQuery: string;
  fromDate?: string;       // ISO 8601 string
  toDate?: string;
  location?: string;
}

// Internal form used during parsing (uses Date objects)
interface ParsedQueryInternal {
  semanticQuery: string;
  fromDate?: Date;
  toDate?: Date;
  location?: string;
}

/**
 * Parse a German natural language photo search query into structured components.
 *
 * Patterns recognized (case-insensitive):
 *   "von 2004 bis 2017"        → fromDate=2004-01-01, toDate=2017-12-31
 *   "zwischen 2004 und 2017"   → same
 *   "2004-2017" / "2004 – 2017" → same
 *   "aus dem Jahr 2019" / "im Jahr 2019" → single year
 *   "im März 2019" / "März 2019" → month + year
 *   "in München" / "aus Berlin" / "bei Hamburg" → location
 */
function parseNaturalQueryInternal(raw: string): ParsedQueryInternal {
  let text = raw.trim();
  let fromDate: Date | undefined;
  let toDate: Date | undefined;
  let location: string | undefined;

  const strip = (match: RegExpExecArray) => {
    text = (text.slice(0, match.index) + " " + text.slice(match.index + match[0].length))
      .replace(/\s{2,}/g, " ").trim();
  };

  // 1. Year range: "von 2004 bis 2017" | "zwischen 2004 und 2017" | "2004-2017"
  const rangePatterns = [
    /\bvon\s+(\d{4})\s+bis\s+(\d{4})\b/i,
    /\bzwischen\s+(\d{4})\s+und\s+(\d{4})\b/i,
    /\b(\d{4})\s*[-–]\s*(\d{4})\b/,
    /\b(\d{4})\s+bis\s+(\d{4})\b/i,
  ];
  for (const pattern of rangePatterns) {
    const m = pattern.exec(text);
    if (m) {
      fromDate = new Date(`${m[1]}-01-01T00:00:00`);
      toDate = new Date(`${m[2]}-12-31T23:59:59`);
      strip(m);
      break;
    }
  }

  // 2. Month + year: "im März 2019" | "März 2019"
  if (!fromDate) {
    const monthNames = Object.keys(GERMAN_MONTHS).join("|");
    const monthYearRx = new RegExp(
      `\\b(?:im\\s+|im\\s+monat\\s+)?(${monthNames})(?:\\s+(\\d{4}))?\\b`, "i"
    );
    const m = monthYearRx.exec(text);
    if (m) {
      const month = GERMAN_MONTHS[m[1].toLowerCase()];
      const year = m[2] ? parseInt(m[2]) : new Date().getFullYear();
      fromDate = new Date(year, month - 1, 1);
      toDate = new Date(year, month, 0, 23, 59, 59, 999);
      strip(m);
    }
  }

  // 3. Single year: "aus dem Jahr 2019" | "im Jahr 2019" | bare "2019"
  if (!fromDate) {
    const singleYearPatterns = [
      /\b(?:aus\s+dem\s+jahr|im\s+jahr|vom\s+jahr|von)\s+(\d{4})\b/i,
      /\b(\d{4})\b/,
    ];
    for (const pattern of singleYearPatterns) {
      const m = pattern.exec(text);
      if (m) {
        const year = parseInt(m[1]);
        if (year >= 1800 && year <= 2100) {
          fromDate = new Date(`${year}-01-01T00:00:00`);
          toDate = new Date(`${year}-12-31T23:59:59`);
          strip(m);
          break;
        }
      }
    }
  }

  // 4. Location: "in München" | "aus Berlin" | "bei Hamburg" | "in der Schweiz"
  const locationRx = /\b(?:in\s+(?:der\s+|den\s+|dem\s+)?|aus\s+(?:der\s+|den\s+|dem\s+)?|bei\s+|nahe\s+)([A-ZÄÖÜ][a-zäöüA-ZÄÖÜ\s]{1,30}?)(?=\s|,|$|\.)/;
  const lm = locationRx.exec(text);
  if (lm) {
    location = lm[1].trim();
    strip(lm);
  }

  // Strip leftover German stop words so CLIP gets clean semantic input
  const semanticQuery = text
    .replace(/\b(von|bis|und|im|in|aus|bei|der|die|das|dem|den|nahe|zwischen|jahr|monat|an|am)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { semanticQuery, fromDate, toDate, location };
}

/** Public wrapper: converts internal Date fields to ISO strings for API serialization. */
export function parseNaturalQuery(raw: string): ParsedQuery {
  const internal = parseNaturalQueryInternal(raw);
  return {
    semanticQuery: internal.semanticQuery,
    fromDate: internal.fromDate?.toISOString(),
    toDate: internal.toDate?.toISOString(),
    location: internal.location,
  };
}

/**
 * Parse a query via the embedding service's spaCy + dateparser endpoint.
 * Returns null on any failure so the caller can fall back to the regex parser.
 */
async function parseNaturalQueryRemote(raw: string): Promise<ParsedQueryInternal | null> {
  try {
    const response = await fetch(`${EMBEDDING_SERVICE_URL}/parse/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: raw }),
      // The parser is fast (5-20 ms) but the model load on first call may
      // take a few seconds. 5 s is a safe upper bound; we fall back on timeout.
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json() as {
      semantic_query: string;
      location: string | null;
      from_date: string | null;
      to_date: string | null;
    };
    return {
      semanticQuery: data.semantic_query ?? "",
      location: data.location ?? undefined,
      fromDate: data.from_date ? new Date(data.from_date) : undefined,
      toDate: data.to_date ? new Date(data.to_date) : undefined,
    };
  } catch (err) {
    return null;
  }
}

// ---------- Combined Natural Language Search ----------

export interface NaturalSearchResult extends PhotoSearchResult {
  location_city?: string;
  location_country?: string;
}

export async function searchPhotosNaturalLogic(
  userId: number,
  query: string,
  limit: number = 30,
  threshold: number = 0.18
): Promise<{ results: NaturalSearchResult[]; parsed: ParsedQuery }> {
  // Prefer the spaCy-based parser running in the embedding service – it
  // understands relative dates ("letzten Sommer", "vor 2 Jahren"), case-
  // insensitive locations, and produces fewer false positives. Falls back to
  // the in-process regex parser whenever the service is unreachable, so the
  // search still works in degraded mode.
  const parsed = (await parseNaturalQueryRemote(query)) ?? parseNaturalQueryInternal(query);
  const parsedPublic: ParsedQuery = {
    semanticQuery: parsed.semanticQuery,
    fromDate: parsed.fromDate?.toISOString(),
    toDate: parsed.toDate?.toISOString(),
    location: parsed.location,
  };

  // DB conditions for date + location structural filters
  const dbConditions: ReturnType<typeof and>[] = [
    eq(photos.user_id, userId),
    or(sql`${photoCuration.status} IS NULL`, sql`${photoCuration.status} != 'hidden'`),
  ];
  if (parsed.fromDate) {
    dbConditions.push(sql`COALESCE(${photos.taken_at}, ${photos.created_at}) >= ${parsed.fromDate.toISOString()}`);
  }
  if (parsed.toDate) {
    dbConditions.push(sql`COALESCE(${photos.taken_at}, ${photos.created_at}) <= ${parsed.toDate.toISOString()}`);
  }
  if (parsed.location) {
    dbConditions.push(
      or(
        ilike(photos.location_city, `%${parsed.location}%`),
        ilike(photos.location_country, `%${parsed.location}%`),
        ilike(photos.location_name, `%${parsed.location}%`),
      )
    );
  }

  const hasStructuredFilter = !!(parsed.fromDate || parsed.location);
  const hasSemanticQuery = parsed.semanticQuery.length > 0;

  // Text token search: every whitespace-separated token of the semantic query
  // must appear (case-insensitive substring) in EITHER the photo description
  // OR the imported IPTC keywords. This is what makes "Mariens Geburtstag"
  // find a photo whose description is "Mariens 30. Geburtstag im Garten" or
  // whose keywords contain "Geburtstag" – CLIP alone wouldn't reliably get
  // there.
  const descriptionTokens = parsed.semanticQuery
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
  const buildTextMatchConditions = () => {
    const base: any[] = [
      eq(photos.user_id, userId),
      or(sql`${photoCuration.status} IS NULL`, sql`${photoCuration.status} != 'hidden'`),
    ];
    for (const tok of descriptionTokens) {
      const pattern = `%${tok}%`;
      base.push(
        or(
          ilike(photos.description, pattern),
          // Any single keyword contains the token (case-insensitive substring).
          sql`EXISTS (SELECT 1 FROM unnest(${photos.keywords}) AS k WHERE k ILIKE ${pattern})`,
        )
      );
    }
    if (parsed.fromDate) {
      base.push(sql`COALESCE(${photos.taken_at}, ${photos.created_at}) >= ${parsed.fromDate.toISOString()}`);
    }
    if (parsed.toDate) {
      base.push(sql`COALESCE(${photos.taken_at}, ${photos.created_at}) <= ${parsed.toDate.toISOString()}`);
    }
    if (parsed.location) {
      base.push(
        or(
          ilike(photos.location_city, `%${parsed.location}%`),
          ilike(photos.location_country, `%${parsed.location}%`),
          ilike(photos.location_name, `%${parsed.location}%`),
        )
      );
    }
    return base;
  };
  const fetchDescriptionMatchIds = async (): Promise<number[]> => {
    if (descriptionTokens.length === 0) return [];
    const rows = await dbAll<{ id: number }>(
      db.select({ id: photos.id })
        .from(photos)
        .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
        .where(and(...buildTextMatchConditions()))
        .limit(limit)
    );
    return rows.map(r => r.id);
  };

  const selectFields = {
    id: photos.id, filename: photos.filename, taken_at: photos.taken_at,
    created_at: photos.created_at, location_city: photos.location_city,
    location_country: photos.location_country,
  };

  type PhotoRow = {
    id: number; filename: string; taken_at: string | null; created_at: string | null;
    location_city: string | null; location_country: string | null;
  };

  const toResult = (p: PhotoRow, score: number): NaturalSearchResult => ({
    photoId: p.id, score, filename: p.filename,
    taken_at: p.taken_at ?? undefined, created_at: p.created_at ?? "",
    location_city: p.location_city ?? undefined, location_country: p.location_country ?? undefined,
  });

  // Case A: no semantic part → pure DB filter (date/location only)
  if (!hasSemanticQuery) {
    const rows = await dbAll<PhotoRow>(
      db.select(selectFields)
        .from(photos)
        .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
        .where(and(...dbConditions))
        .orderBy(photoDateOrder)
        .limit(limit)
    );
    return { parsed: parsedPublic, results: rows.map(r => toResult(r, 1.0)) };
  }

  // Case B: semantic only, no structural filters → CLIP ∪ description matches
  if (!hasStructuredFilter) {
    const [clipResp, descIds] = await Promise.all([
      fetchWithTimeout(`${EMBEDDING_SERVICE_URL}/search/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: parsed.semanticQuery.slice(0, EMBEDDING_TEXT_SEARCH_MAX_QUERY_LEN),
          k: Math.min(limit, EMBEDDING_TEXT_SEARCH_MAX_K),
          threshold,
        }),
        timeoutMs: ML_RPC_QUICK_TIMEOUT_MS,
      }),
      fetchDescriptionMatchIds(),
    ]);
    if (!clipResp.ok) throw new Error(`Embedding service error: ${clipResp.status}`);
    const clipData = await clipResp.json() as { results: Array<{ photo_id: string; score: number }> };
    const clipScores = new Map<number, number>();
    for (const r of clipData.results) {
      const id = parseInt(r.photo_id, 10);
      if (!isNaN(id)) clipScores.set(id, r.score);
    }
    // Description matches get a score of 1.0 (explicit text match wins over
    // CLIP similarity); CLIP-only hits keep their cosine score.
    const merged = new Map<number, number>(clipScores);
    for (const id of descIds) merged.set(id, 1.0);
    if (merged.size === 0) return { results: [], parsed: parsedPublic };

    const ids = [...merged.keys()];
    const rows = await dbAll<PhotoRow>(
      db.select(selectFields).from(photos)
        .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
        .where(and(eq(photos.user_id, userId), inArray(photos.id, ids)))
    );
    const ordered = rows
      .map(r => toResult(r, merged.get(r.id) ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return { parsed: parsedPublic, results: ordered };
  }

  // Case C: semantic + structural → (CLIP ∩ structural) ∪ description matches
  // Pre-fetch candidate IDs matching date + location constraints
  const candidateRows = await dbAll<{ id: number }>(
    db.select({ id: photos.id })
      .from(photos)
      .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
      .where(and(...dbConditions))
  );
  const candidateSet = new Set(candidateRows.map(r => r.id));
  if (candidateSet.size === 0) return { results: [], parsed: parsedPublic };

  // Request enlarged k so intersection still yields enough results.
  // Must stay within the embedding service's TextSearchRequest.k upper bound
  // (1000) — exceeding it would produce a 422 Unprocessable Entity.
  const clipK = Math.min(candidateSet.size, limit * 5, EMBEDDING_TEXT_SEARCH_MAX_K);
  const [clipResp, descIds] = await Promise.all([
    fetchWithTimeout(`${EMBEDDING_SERVICE_URL}/search/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: parsed.semanticQuery.slice(0, EMBEDDING_TEXT_SEARCH_MAX_QUERY_LEN),
        k: clipK,
        threshold,
      }),
      timeoutMs: ML_RPC_QUICK_TIMEOUT_MS,
    }),
    // fetchDescriptionMatchIds already applies the same structural filter,
    // so we don't need to intersect manually.
    fetchDescriptionMatchIds(),
  ]);
  if (!clipResp.ok) throw new Error(`Embedding service error: ${clipResp.status}`);
  const clipData = await clipResp.json() as { results: Array<{ photo_id: string; score: number }> };

  // Score map: CLIP hits inside the structural candidate set + description matches.
  const merged = new Map<number, number>();
  for (const r of clipData.results) {
    const id = parseInt(r.photo_id, 10);
    if (!isNaN(id) && candidateSet.has(id)) merged.set(id, r.score);
  }
  for (const id of descIds) merged.set(id, 1.0);
  if (merged.size === 0) return { results: [], parsed: parsedPublic };

  const ids = [...merged.keys()];
  const rows = await dbAll<PhotoRow>(
    db.select(selectFields).from(photos)
      .where(and(eq(photos.user_id, userId), inArray(photos.id, ids)))
  );
  const ordered = rows
    .map(r => toResult(r, merged.get(r.id) ?? 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { parsed: parsedPublic, results: ordered };
}

// ========================================================================
// Photo Purge (destructive — requires photos.purge permission)
// ========================================================================

export interface PurgeFilesResult {
  deleted: boolean;
  uploadsRemoved: number;
  thumbnailsRemoved: number;
  failures: number;
}

export interface PurgeEmbeddingServiceResult {
  called: boolean;
  ok: boolean;
  deleted: number;
  error: string;
}

export interface PurgeResult {
  success: boolean;
  /** Rows removed from each affected table. Order reflects FK dependencies. */
  dbCounts: Record<string, number>;
  /** When `deleteFiles` is true: number of removed files / failed removals. */
  files: PurgeFilesResult;
  /** Result of the embedding-service `/photos` DELETE. */
  embeddingService: PurgeEmbeddingServiceResult;
}

/**
 * Recursively remove every entry inside `dir` but keep `dir` itself.
 * Returns a tuple of (removedCount, failedCount). Swallows per-entry errors
 * so a single failure doesn't abort the purge.
 */
async function emptyDirectory(dir: string): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return { removed: 0, failed: 0 };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const stat = await fs.promises.lstat(full);
      if (stat.isDirectory()) {
        await fs.promises.rm(full, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(full);
      }
      removed++;
    } catch (err) {
      console.error(`[purge] Failed to remove ${full}:`, err);
      failed++;
    }
  }
  return { removed, failed };
}

/**
 * Purge ALL photo-related data for the whole installation.
 *
 * Tables cleared (in FK-safe order):
 *   photo_scan_queue → photo_landmarks → user_face_assignments → faces
 *   → photo_group_members → photo_groups
 *   → album_photos → album_shares → album_public_links → album_user_settings
 *   → albums → persons → photo_curation → photos
 *
 * User accounts, roles, permissions and other non-photo data are preserved.
 *
 * When `deleteFiles` is true, every file inside UPLOAD_DIR and THUMBNAIL_DIR
 * is removed as well (the directories themselves stay so subsequent uploads
 * keep working). The embedding service's vector store is cleared in both
 * modes — it's worthless once the photos table is empty.
 */
export async function purgeAllPhotosLogic(deleteFiles: boolean): Promise<PurgeResult> {
  const dbCounts: Record<string, number> = {};
  const runDelete = async (label: string, q: Promise<{ changes: number }>): Promise<void> => {
    const res = await q;
    dbCounts[label] = res?.changes ?? 0;
  };

  // FK-safe deletion order. Child tables first, then parents.
  await runDelete("photo_scan_queue", dbExec(db.delete(photoScanQueue)));
  await runDelete("photo_landmarks", dbExec(db.delete(photoLandmarks)));
  await runDelete("user_face_assignments", dbExec(db.delete(userFaceAssignments)));
  await runDelete("faces", dbExec(db.delete(faces)));

  await runDelete("photo_group_members", dbExec(db.delete(photoGroupMembers)));
  await runDelete("photo_groups", dbExec(db.delete(photoGroups)));

  await runDelete("album_photos", dbExec(db.delete(albumPhotos)));
  await runDelete("album_shares", dbExec(db.delete(albumShares)));
  await runDelete("album_public_links", dbExec(db.delete(albumPublicLinks)));
  await runDelete("album_user_settings", dbExec(db.delete(albumUserSettings)));
  await runDelete("albums", dbExec(db.delete(albums)));

  await runDelete("persons", dbExec(db.delete(persons)));
  await runDelete("photo_curation", dbExec(db.delete(photoCuration)));
  await runDelete("photos", dbExec(db.delete(photos)));

  // Clear the embedding-service vector store so stale embeddings don't
  // outlive the photos they describe.
  const embeddingService: PurgeEmbeddingServiceResult = {
    called: true,
    ok: false,
    deleted: 0,
    error: "",
  };
  try {
    const resp = await fetchWithTimeout(`${EMBEDDING_SERVICE_URL}/photos`, { method: "DELETE" });
    if (resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as { deleted?: number };
      embeddingService.ok = true;
      embeddingService.deleted = body?.deleted ?? 0;
    } else {
      embeddingService.error = `HTTP ${resp.status}`;
    }
  } catch (err: any) {
    embeddingService.error = err?.message || String(err);
  }

  // Reset internal AI-user cache so the next lookup refreshes its state.
  _aiUserId = undefined;

  // Optionally wipe files.
  const files: PurgeResult["files"] = {
    deleted: deleteFiles,
    uploadsRemoved: 0,
    thumbnailsRemoved: 0,
    failures: 0,
  };
  if (deleteFiles) {
    const uploads = await emptyDirectory(UPLOAD_DIR);
    const thumbs = await emptyDirectory(THUMBNAIL_DIR);
    files.uploadsRemoved = uploads.removed;
    files.thumbnailsRemoved = thumbs.removed;
    files.failures = uploads.failed + thumbs.failed;

    // Recreate the temp-staging subdir that uploads rely on.
    if (!fs.existsSync(UPLOAD_TMP_DIR)) {
      fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
    }
  }

  return { success: true, dbCounts, files, embeddingService };
}
