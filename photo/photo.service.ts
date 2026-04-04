import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import exifr from "exifr";
import { exiftool } from "exiftool-vendored";
import { eq, and, or, sql, inArray, ilike, isNull, isNotNull, desc } from "drizzle-orm";
import { enqueuePhotoScan, DeferJobError } from "./scan-queue";
import { triggerWorkers } from "./scan-worker";
import db from "../db/database";
import { dbFirst, dbAll, dbExec, dbInsertReturning } from '../db/adapter';
import type { IncomingMessage } from "http";
import { pipeline } from "stream/promises";
import {
  photos,
  albums,
  albumPhotos,
  albumShares,
  persons,
  faces,
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
  ListAlbumsResponse,
  ListPhotosResponse,
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
import sharp from "sharp";

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
const INSIGHTFACE_SERVICE_URL = process.env.INSIGHTFACE_SERVICE_URL || "http://localhost:8000";

const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
  "image/heic", "image/heif", "image/tiff", "image/bmp", "image/svg+xml",
]);
const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || "http://localhost:8001";
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
export const ENABLE_LOCAL_FACES = process.env.ENABLE_LOCAL_FACES === "true";
const LANDMARK_SERVICE_URL = process.env.LANDMARK_SERVICE_URL || "http://localhost:8002";
export const ENABLE_LANDMARKS = process.env.ENABLE_LANDMARKS === "true";
export const ENABLE_QUALITY = process.env.ENABLE_QUALITY !== "false"; // enabled by default

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
if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

// ---------- People & Faces ----------

async function callInsightFaceDetect(filePath: string): Promise<{ faces: any[], width: number, height: number }> {
  const formData = new FormData();
  const fileData = await fs.promises.readFile(filePath);
  const blob = new Blob([fileData], { type: getUploadMimeType(filePath) });
  formData.append('file', blob, path.basename(filePath));

  const response = await fetch(`${INSIGHTFACE_SERVICE_URL}/detect`, {
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

  const response = await fetch(`${EMBEDDING_SERVICE_URL}/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding service returned ${response.status}: ${errorText}`);
  }
  console.log(`Successfully uploaded photo ${photoId} to embedding service.`);
}

export async function indexPhotoEmbeddings(userId: number, photoId: number, force: boolean = false): Promise<void> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );
  if (!photo) return;

  const filePath = path.join(UPLOAD_DIR, photo.filename);
  if (!fs.existsSync(filePath)) return;

  // Get face IDs for this photo (optional, but good for completeness if we have them)
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
  // Collect non-ignored face bboxes
  const faceRows = await dbAll<{ bbox: string }>(
    db.select({ bbox: faces.bbox }).from(faces)
      .where(and(eq(faces.photo_id, photoId), eq(faces.user_id, userId), eq(faces.ignored, false)))
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

  // Fallback: use landmark with highest confidence
  const landmarkRows = await dbAll<{ bbox: string; confidence: number }>(
    db.select({ bbox: photoLandmarks.bbox, confidence: photoLandmarks.confidence })
      .from(photoLandmarks)
      .where(and(eq(photoLandmarks.photo_id, photoId), eq(photoLandmarks.user_id, userId)))
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

export async function indexPhotoFaces(userId: number, photoId: number, resetIgnored: boolean = false): Promise<void> {
  if (!ENABLE_LOCAL_FACES) {
    console.log("Local face indexing is disabled via ENABLE_LOCAL_FACES=false");
    return;
  }

  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );
  if (!photo) return;

  const filePath = path.join(UPLOAD_DIR, photo.filename);
  if (!fs.existsSync(filePath)) return;

  let processingPath = filePath;
  let tempPath: string | null = null;

  // Check if it's a HEIC file – use heif-convert (libheif) since sharp may lack HEIC support
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

  // Get existing ignored faces for this photo to preserve them (if not resetting)
  const ignoredFaces = resetIgnored ? [] : await dbAll<typeof faces.$inferSelect>(db.select().from(faces).where(and(eq(faces.photo_id, photoId), eq(faces.ignored, true))));

  // Remove faces for this photo
  if (resetIgnored) {
    // Remove ALL faces (including ignored ones)
    await dbExec(db.delete(faces).where(eq(faces.photo_id, photoId)));
  } else {
    // Only remove non-ignored faces
    await dbExec(db.delete(faces).where(and(eq(faces.photo_id, photoId), eq(faces.ignored, false))));
  }

  try {
    const detectResult = await callInsightFaceDetect(processingPath);
    const facesDetected = detectResult.faces;
    const imgWidth = detectResult.width;
    const imgHeight = detectResult.height;
    
    console.log(`Detected ${facesDetected.length} faces in photo ${photoId} (size: ${imgWidth}x${imgHeight})`);

    for (const f of facesDetected) {
      // Normalize bbox to 0..1 relative values
      const bbox = {
        x: f.bbox[0] / imgWidth,
        y: f.bbox[1] / imgHeight,
        width: (f.bbox[2] - f.bbox[0]) / imgWidth,
        height: (f.bbox[3] - f.bbox[1]) / imgHeight
      };

      // Check if this face matches an ignored one (by bbox overlap)
      const isIgnored = ignoredFaces.some(iface => {
        const iBbox = JSON.parse(iface.bbox);
        return calculateOverlap(bbox, iBbox) > 0.8; // 80% overlap threshold
      });

      if (isIgnored) continue;

      const embedding = f.embedding;

      // Find best matching person (using cosine similarity)
      const match = await findBestPersonMatch(userId, embedding);

      let personId = match?.personId;
      if (!personId) {
        // Create new person
        const newPerson = await dbInsertReturning<typeof persons.$inferSelect>(
          db.insert(persons).values({ user_id: userId, name: "Unbenannt" }).returning()
        );
        personId = newPerson!.id;
      }

      const faceResult = await dbInsertReturning<typeof faces.$inferSelect>(
        db.insert(faces)
          .values({
            user_id: userId,
            photo_id: photoId,
            bbox: JSON.stringify(bbox),
            embedding: JSON.stringify(embedding),
            person_id: personId,
            quality: 100,
          })
          .returning()
      );

      // Set cover_face_id if not set for person OR if it refers to a non-existent face
      const currentPerson = await dbFirst<typeof persons.$inferSelect>(db.select().from(persons).where(eq(persons.id, personId)));
      let needsCoverUpdate = false;
      if (currentPerson) {
          if (!currentPerson.cover_face_id) {
              needsCoverUpdate = true;
          } else {
              const coverFaceExists = await dbFirst<{ id: number }>(db.select({ id: faces.id }).from(faces).where(eq(faces.id, currentPerson.cover_face_id)));
              if (!coverFaceExists) {
                  needsCoverUpdate = true;
              }
          }
      }

      if (needsCoverUpdate) {
          await dbExec(db.update(persons).set({
              cover_face_id: faceResult!.id,
              updated_at: new Date().toISOString(),
          }).where(eq(persons.id, personId)));
      } else {
          await dbExec(db.update(persons).set({
              updated_at: new Date().toISOString(),
          }).where(eq(persons.id, personId)));
      }
    }
  } catch (err) {
    console.error(`Error indexing faces for photo ${photoId}:`, err);
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        await fs.promises.unlink(tempPath);
      } catch (e) {
        // Ignore
      }
    }
  }

  // Recompute auto-crop focus point after face changes
  try {
    await computeAndStoreAutoCrop(userId, photoId);
  } catch (err) {
    console.error(`Error computing auto-crop for photo ${photoId}:`, err);
  }
}

interface ExifMetadata {
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
}

async function getExifMetadata(filePath: string): Promise<ExifMetadata> {
  try {
    const data = await exifr.parse(filePath, { gps: true });
    let takenAt: string | null = null;
    if (data?.DateTimeOriginal) {
      takenAt = new Date(data.DateTimeOriginal).toISOString();
    } else if (data?.CreateDate) {
      takenAt = new Date(data.CreateDate).toISOString();
    }
    return {
      takenAt,
      latitude: data?.latitude ?? null,
      longitude: data?.longitude ?? null,
    };
  } catch (err) {
    console.error("Error parsing EXIF data:", err);
    return { takenAt: null, latitude: null, longitude: null };
  }
}

async function getExifDate(filePath: string): Promise<string | null> {
  return (await getExifMetadata(filePath)).takenAt;
}

interface GeocodeResult {
  displayName: string;
  city: string | null;
  country: string | null;
}

async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResult> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=de`;
    const res = await fetch(url, {
      headers: { "User-Agent": "fk-encore-photo-app/1.0" },
    });
    if (!res.ok) return { displayName: "", city: null, country: null };
    const data = await res.json() as Record<string, any>;
    return {
      displayName: data.display_name ?? "",
      city: data.address?.city ?? data.address?.town ?? data.address?.village ?? null,
      country: data.address?.country ?? null,
    };
  } catch (err) {
    console.error("Nominatim reverse geocoding failed:", err);
    return { displayName: "", city: null, country: null };
  }
}

async function geocodePhotoLocation(userId: number, photoId: number, lat: number, lon: number): Promise<void> {
  const geo = await reverseGeocode(lat, lon);
  await dbExec(
    db.update(photos)
      .set({
        location_name: geo.displayName || null,
        location_city: geo.city,
        location_country: geo.country,
      })
      .where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );
}

/**
 * Scan-queue job handler for geocoding.
 * 1. If the photo has no GPS coordinates, tries EXIF extraction.
 * 2. If GPS is available, calls Nominatim for reverse-geocoding.
 * 3. Succeeds silently when no GPS data exists (nothing to geocode).
 */
export async function indexPhotoGeocoding(userId: number, photoId: number, force = false): Promise<void> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );
  if (!photo) return;

  let lat = photo.latitude;
  let lon = photo.longitude;

  // Try EXIF extraction if no GPS stored yet
  if (lat === null || lon === null) {
    const filePath = path.join(UPLOAD_DIR, photo.filename);
    if (!fs.existsSync(filePath)) return; // file gone — nothing we can do
    const exifMeta = await getExifMetadata(filePath);
    if (exifMeta.latitude !== null && exifMeta.longitude !== null) {
      lat = exifMeta.latitude;
      lon = exifMeta.longitude;
      await dbExec(
        db.update(photos).set({ latitude: lat, longitude: lon }).where(eq(photos.id, photoId))
      );
    }
  }

  // No GPS available at all — mark as done (nothing to geocode)
  if (lat === null || lon === null) return;

  // Already has a location name — skip unless this is a forced rescan
  if (photo.location_name && !force) return;

  await geocodePhotoLocation(userId, photoId, lat, lon);
}

// ---------- Photos ----------

export async function uploadPhotoStream(
  userId: number,
  stream: IncomingMessage,
  originalName: string,
  mimeType: string
): Promise<Photo> {
  if (!SUPPORTED_MIME_TYPES.has(mimeType.toLowerCase().split(";")[0].trim())) {
    throw new Error("UNSUPPORTED_FILE_TYPE");
  }

  const filename = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}${path.extname(originalName)}`;
  const filePath = path.join(UPLOAD_DIR, filename);

  const fileStream = fs.createWriteStream(filePath);
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
  const exifMeta = await getExifMetadata(filePath);

  // Check for duplicate for this user
  const existing = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.user_id, userId), eq(photos.hash, digest)))
  );

  if (existing) {
    // Delete the temporary file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    throw new Error("PHOTO_ALREADY_EXISTS");
  }

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
    }).returning()
  );

  // Add to scan queue and wake workers — upload returns immediately
  enqueuePhotoScan(row!.id, userId).then(() => triggerWorkers()).catch(err => {
    console.error("Enqueue error:", err);
  });

  // Reverse-geocode GPS coordinates in background
  if (exifMeta.latitude !== null && exifMeta.longitude !== null) {
    geocodePhotoLocation(userId, row!.id, exifMeta.latitude, exifMeta.longitude).catch(err => {
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

  const filename = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}${path.extname(file.name)}`;
  const filePath = path.join(UPLOAD_DIR, filename);

  fs.writeFileSync(filePath, file.data);

  // Extraction of EXIF data (date + GPS)
  const exifMeta2 = await getExifMetadata(filePath);

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
    }).returning()
  );

  // Add to scan queue and wake workers — upload returns immediately
  enqueuePhotoScan(row2!.id, userId).then(() => triggerWorkers()).catch(err => {
    console.error("Enqueue error:", err);
  });

  // Reverse-geocode GPS coordinates in background
  if (exifMeta2.latitude !== null && exifMeta2.longitude !== null) {
    geocodePhotoLocation(userId, row2!.id, exifMeta2.latitude, exifMeta2.longitude).catch(err => {
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
  };
}

export async function listPhotosLogic(userId: number, showHidden: boolean = false): Promise<ListPhotosResponse> {
  const rows = await dbAll<{
    id: number; user_id: number; filename: string; original_name: string;
    mime_type: string; size: number; hash: string | null; taken_at: string | null;
    created_at: string | null; curation_status: string | null;
    latitude: number | null; longitude: number | null;
    location_name: string | null; location_city: string | null; location_country: string | null;
    ai_quality_score: number | null;
    ai_quality_details: Record<string, number> | null;
    auto_crop: { x: number; y: number } | null;
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
        ai_quality_score: photos.ai_quality_score,
        ai_quality_details: photos.ai_quality_details,
        auto_crop: photos.auto_crop,
      })
      .from(photos)
      .leftJoin(
        photoCuration,
        and(eq(photos.id, photoCuration.photo_id), eq(photoCuration.user_id, userId))
      )
      .where(eq(photos.user_id, userId))
      .orderBy(sql`${photoDateOrder} DESC`)
  );

  const filtered = showHidden ? rows : rows.filter((r) => (r.curation_status ?? "visible") !== "hidden");

  return {
    photos: filtered.map((r) => ({
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
      ai_quality_score: r.ai_quality_score ?? undefined,
      ai_quality_details: r.ai_quality_details ?? undefined,
      auto_crop: r.auto_crop ?? undefined,
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
  const prefix = `${baseName}_`;
  const shardPath = thumbnailShardPath(baseName);
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

  // Delete original file and all cached thumbnails from disk
  const filePath = path.join(UPLOAD_DIR, photo.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
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
  // is part of an album that has been shared with the requester.
  if (photo.user_id !== userId) {
    // Only allow non-owners to change curation when they have WRITE access to
    // an album that contains the photo. View-only (read) shares are not
    // permitted to hide/curate photos.
    const shared = await dbFirst(
      db
        .select({ album_id: albumPhotos.album_id })
        .from(albumPhotos)
        .innerJoin(albumShares, eq(albumShares.album_id, albumPhotos.album_id))
        .where(and(
          eq(albumPhotos.photo_id, photoId),
          eq(albumShares.user_id, userId),
          eq(albumShares.access_level, "write")
        ))
    );
    if (!shared) {
      throw new Error("Photo not found or unauthorized");
    }
  }

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

  const filePath = path.join(UPLOAD_DIR, photo.filename);
  if (!fs.existsSync(filePath)) {
    throw new Error("File not found on disk");
  }

  const takenAt = await getExifDate(filePath);

  // Always update, even if takenAt is null (to sync with current logic if it was different before)
  await dbExec(db.update(photos).set({ taken_at: takenAt }).where(eq(photos.id, photoId)));

  return { success: true, taken_at: takenAt ?? undefined };
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

  const filePath = path.join(UPLOAD_DIR, photo.filename);
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

    // Write to multiple tags to ensure compatibility
    await Promise.race([
      exiftool.write(filePath, {
        DateTimeOriginal: formattedDate,
        CreateDate: formattedDate,
        ModifyDate: formattedDate,
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
  // sharp's bundled libvips lacks HEIC decode support; use heic-convert (libheif via WASM) instead.
  const inputBuffer = await fs.promises.readFile(filePath);
  const outputBuffer = await heicConvert({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 });
  return Buffer.from(outputBuffer);
}

/**
 * Resize an image buffer to the given target width, preserving aspect ratio.
 * Always outputs JPEG. If the image is already smaller than targetWidth, it is
 * returned as-is (no upscaling). Returns a JPEG buffer.
 */
export async function resizeImage(imageBuffer: Buffer, targetWidth: number): Promise<Buffer> {
  // .rotate() with no arguments auto-orients based on EXIF orientation tag
  return sharp(imageBuffer)
    .rotate()
    .resize(targetWidth, null, { withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

// ---------- Albums ----------

async function getAlbumStats(albumId: number): Promise<{ newest_photo_at?: string, oldest_photo_at?: string, photo_count: number, newest_photo_filename?: string }> {
  const stats = await dbFirst<any>(
    db.select({
      newest_photo_at: sql<string>`MAX(COALESCE(${photos.taken_at}, ${photos.created_at}))`,
      oldest_photo_at: sql<string>`MIN(COALESCE(${photos.taken_at}, ${photos.created_at}))`,
      photo_count: sql<number>`COUNT(*)`,
    })
    .from(albumPhotos)
    .innerJoin(photos, eq(albumPhotos.photo_id, photos.id))
    .where(eq(albumPhotos.album_id, albumId))
  );

  let newestFilename: string | undefined = undefined;
  if (stats && Number(stats.photo_count) > 0) {
    const newest = await dbFirst<any>(
      db.select({ filename: photos.filename })
      .from(albumPhotos)
      .innerJoin(photos, eq(albumPhotos.photo_id, photos.id))
      .where(eq(albumPhotos.album_id, albumId))
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
    db.insert(albums).values({ user_id: userId, name: req.name, description: req.description ?? null }).returning()
  );

  return {
    id: row!.id,
    user_id: row!.user_id,
    name: row!.name,
    description: row!.description ?? undefined,
    cover_photo_id: row!.cover_photo_id ?? undefined,
    cover_filename: undefined,
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
        cover_photo_id: albums.cover_photo_id,
        created_at: albums.created_at,
        updated_at: albums.updated_at,
        is_shared: sql<boolean>`EXISTS (
          SELECT 1 FROM ${albumShares}
          WHERE ${albumShares.album_id} = ${albums.id}
        )`,
        cover_filename: sql<string>`COALESCE(
          ${photos.filename},
          (
            SELECT ${photos.filename}
            FROM ${albumPhotos}
            JOIN ${photos} ON ${albumPhotos.photo_id} = ${photos.id}
            WHERE ${albumPhotos.album_id} = ${albums.id}
            ORDER BY COALESCE(${photos.taken_at}, ${photos.created_at}) DESC
            LIMIT 1
          )
        )`,
        newest_photo_at: sql<string>`(
          SELECT MAX(COALESCE(${photos.taken_at}, ${photos.created_at}))
          FROM ${albumPhotos}
          JOIN ${photos} ON ${albumPhotos.photo_id} = ${photos.id}
          WHERE ${albumPhotos.album_id} = ${albums.id}
        )`,
        oldest_photo_at: sql<string>`(
          SELECT MIN(COALESCE(${photos.taken_at}, ${photos.created_at}))
          FROM ${albumPhotos}
          JOIN ${photos} ON ${albumPhotos.photo_id} = ${photos.id}
          WHERE ${albumPhotos.album_id} = ${albums.id}
        )`,
        photo_count: sql<number>`(
          SELECT COUNT(*)
          FROM ${albumPhotos}
          WHERE ${albumPhotos.album_id} = ${albums.id}
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
  all:       { hideFilter: "mine",      favFilter: "all" },
  favorites: { hideFilter: "mine",      favFilter: "mine" },
  consensus: { hideFilter: "consensus", favFilter: "consensus", hideConsensusMin: 1, favConsensusMin: 2 },
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
      p.taken_at, p.created_at, p.ai_quality_score, p.auto_crop,
      ap.added_by_user_id, ap.added_at,
      my_pc.status AS curation_status,
      COALESCE(SUM(CASE WHEN all_pc.status = 'favorite' THEN 1 ELSE 0 END), 0)::int AS fav_count,
      COALESCE(SUM(CASE WHEN all_pc.status = 'hidden' THEN 1 ELSE 0 END), 0)::int AS hide_count
    FROM photos p
    INNER JOIN album_photos ap ON ap.photo_id = p.id AND ap.album_id = ${albumId}
    LEFT JOIN photo_curation my_pc ON my_pc.photo_id = p.id AND my_pc.user_id = ${userId}
    LEFT JOIN photo_curation all_pc ON all_pc.photo_id = p.id AND all_pc.user_id = ANY(ARRAY[${sql.join(participantIds.map(id => sql`${id}`), sql`, `)}]::int[])
    GROUP BY p.id, p.user_id, p.filename, p.original_name, p.mime_type, p.size, p.hash,
             p.taken_at, p.created_at, p.ai_quality_score, p.auto_crop, ap.added_by_user_id, ap.added_at, my_pc.status
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
    }
    // favFilter === "all" → no filtering

    return true;
  });

  const stats = await getAlbumStats(albumId);
  // Determine cover photo: prefer user-specific cover, then album's cover, then newest in album
  let coverFilename: string | undefined = undefined;
  let coverPhotoIdToUse: number | null | undefined = (settings as any).cover_photo_id;
  if (!coverPhotoIdToUse) {
    coverPhotoIdToUse = album.cover_photo_id ?? null;
  }
  if (coverPhotoIdToUse) {
    const cp = await dbFirst<any>(db.select({ filename: photos.filename }).from(photos).where(eq(photos.id, coverPhotoIdToUse)));
    coverFilename = cp?.filename;
  } else {
    coverFilename = stats.newest_photo_filename;
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
    newest_photo_at: stats.newest_photo_at,
    oldest_photo_at: stats.oldest_photo_at,
    photo_count: stats.photo_count,
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
      curation_stats: isShared ? {
        fav_count: Number(r.fav_count),
        hide_count: Number(r.hide_count),
        member_count: memberCount,
      } : undefined,
    })),
  };
}

export async function updateAlbumUserSettingsLogic(userId: number, req: UpdateAlbumUserSettingsRequest): Promise<AlbumUserSettings> {
  const values: any = {};
  if (req.hideMode) values.hide_mode = req.hideMode;
  if (req.activeView) values.active_view = req.activeView;
  if (req.viewConfig !== undefined) values.view_config = req.viewConfig;
  if ((req as any).coverPhotoId !== undefined) values.cover_photo_id = (req as any).coverPhotoId;

  // When switching to a preset, store corresponding view_config for consistency
  if (req.activeView && req.activeView in VIEW_PRESETS && req.viewConfig === undefined) {
    values.view_config = VIEW_PRESETS[req.activeView];
  }

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
  const stats = await getAlbumStats(req.id);
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
  return { success: true };
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

  return {
    shares: rows.map(r => ({
      album_id: r.album_id,
      user_id: r.user_id,
      access_level: r.access_level as "read" | "write",
      user_name: r.name,
      user_email: r.email,
    })),
  };
}

export async function removeAlbumShareLogic(userId: number, req: RemoveAlbumShareRequest): Promise<{ success: boolean }> {
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, req.albumId))
  );
  if (!album) throw new Error("Album not found");
  if (album.user_id !== userId) throw new Error("Only owner can remove shares");

  await dbExec(
    db.delete(albumShares).where(and(eq(albumShares.album_id, req.albumId), eq(albumShares.user_id, req.userId)))
  );
  return { success: true };
}

async function findBestPersonMatch(
  userId: number,
  embedding: number[]
): Promise<{ personId: number; distance: number } | null> {
  const allFaces = await dbAll<{ person_id: number | null; embedding: string }>(
    db
      .select({ person_id: faces.person_id, embedding: faces.embedding })
      .from(faces)
      .where(and(eq(faces.user_id, userId), sql`${faces.person_id} IS NOT NULL`, eq(faces.ignored, false)))
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
  }>(db.select({
      id: persons.id,
      user_id: persons.user_id,
      name: persons.name,
      cover_face_id: sql<number>`COALESCE(
        (
          SELECT f.id
          FROM faces f
          INNER JOIN photos p ON p.id = f.photo_id
          WHERE f.person_id = persons.id
            AND f.user_id = persons.user_id
            AND f.ignored = ${rawFalse}
          ORDER BY ${rawCoalesceDate} DESC NULLS LAST, f.id DESC
          LIMIT 1
        ),
        persons.cover_face_id
      )`,
      created_at: persons.created_at,
      updated_at: persons.updated_at,
      faceCount: sql<number>`CAST(COALESCE((SELECT count(*) FROM faces f WHERE f.person_id = persons.id AND f.ignored = ${rawFalse}), 0) AS INTEGER)`,
      cover_filename: sql<string>`COALESCE(
        (
          SELECT p.filename
          FROM faces f
          INNER JOIN photos p ON p.id = f.photo_id
          WHERE f.person_id = persons.id
            AND f.user_id = persons.user_id
            AND f.ignored = ${rawFalse}
          ORDER BY ${rawCoalesceDate} DESC NULLS LAST, f.id DESC
          LIMIT 1
        ),
        ''
      )`,
      cover_bbox: sql<string>`COALESCE(
        (
          SELECT f.bbox
          FROM faces f
          INNER JOIN photos p ON p.id = f.photo_id
          WHERE f.person_id = persons.id
            AND f.user_id = persons.user_id
            AND f.ignored = ${rawFalse}
          ORDER BY ${rawCoalesceDate} DESC NULLS LAST, f.id DESC
          LIMIT 1
        ),
        ''
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
        user_id: faces.user_id,
        photo_id: faces.photo_id,
        bbox: faces.bbox,
        embedding: faces.embedding,
        person_id: faces.person_id,
        quality: faces.quality,
        ignored: faces.ignored,
        created_at: faces.created_at,
        filename: photos.filename,
        original_name: photos.original_name,
        taken_at: photos.taken_at,
      })
      .from(faces)
      .innerJoin(photos, eq(faces.photo_id, photos.id))
      .where(and(eq(faces.person_id, personId), eq(faces.user_id, userId)))
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
        created_at: "", // Not strictly needed here, but part of the type
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
        faceCount: sql<number>`CAST(COALESCE((SELECT count(*) FROM faces f WHERE f.person_id = persons.id AND f.ignored = ${rawFalse}), 0) AS INTEGER)`,
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

  // Move all faces from source persons to target person
  await dbExec(
    db.update(faces)
      .set({ person_id: targetId })
      .where(and(inArray(faces.person_id, sourceIds), eq(faces.user_id, userId)))
  );

  // Update target person's cover face if it doesn't have one
  if (!target.cover_face_id) {
    const firstFace = await dbFirst<{ id: number }>(
      db.select({ id: faces.id })
        .from(faces)
        .where(and(eq(faces.person_id, targetId), eq(faces.user_id, userId)))
        .limit(1)
    );
    if (firstFace) {
      await dbExec(
        db.update(persons).set({ cover_face_id: firstFace.id }).where(eq(persons.id, targetId))
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
    db.update(faces)
      .set({ person_id: personId, ignored: false })
      .where(and(eq(faces.id, faceId), eq(faces.user_id, userId)))
  );
  return { success: true };
}

export async function ignoreFaceLogic(
  userId: number,
  faceId: number
): Promise<{ success: boolean }> {
  await dbExec(
    db.update(faces)
      .set({ ignored: true, person_id: null })
      .where(and(eq(faces.id, faceId), eq(faces.user_id, userId)))
  );
  return { success: true };
}

export async function ignorePersonFacesLogic(
  userId: number,
  personId: number
): Promise<{ success: boolean }> {
  await dbExec(
    db.update(faces)
      .set({ ignored: true, person_id: null })
      .where(and(eq(faces.person_id, personId), eq(faces.user_id, userId)))
  );

  // Also cleanup the person since they no longer have any associated faces
  await cleanupOrphanedPersons(userId);

  return { success: true };
}

export async function getPhotoFacesLogic(
  userId: number,
  photoId: number
): Promise<{ faces: Face[] }> {
  const rows = await dbAll<typeof faces.$inferSelect>(
    db.select().from(faces).where(and(eq(faces.photo_id, photoId), eq(faces.user_id, userId)))
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
  await indexPhotoEmbeddings(userId, photoId, true);
  if (ENABLE_LANDMARKS) {
    await indexPhotoLandmarks(userId, photoId);
  }
  let lat = photo.latitude;
  let lon = photo.longitude;

  if (lat === null || lon === null) {
    const filePath = path.join(UPLOAD_DIR, photo.filename);
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
    await geocodePhotoLocation(userId, photoId, lat, lon);
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

  if (lat === null || lon === null) {
    const filePath = path.join(UPLOAD_DIR, photo.filename);
    if (!fs.existsSync(filePath)) {
      return { gpsFound: false, geocoded: false, scansQueued: false };
    }
    const exifMeta = await getExifMetadata(filePath);
    if (exifMeta.latitude !== null && exifMeta.longitude !== null) {
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
  }

  if (lat !== null && lon !== null && !photo.location_name) {
    await geocodePhotoLocation(userId, photoId, lat, lon);
    geocoded = true;
  }

  return { gpsFound, geocoded, scansQueued };
}

// ── Scan Queue API helpers ───────────────────────────────────────────────────

import { getQueueStatus, requeueFailed, requeueForRescan } from "./scan-queue";

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
  triggerWorkers();
  return { retried };
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
          sql`NOT EXISTS (SELECT 1 FROM faces WHERE faces.person_id = persons.id)`
        )
      )
  );
  console.log(`Cleaned up ${deleted.changes} orphaned persons for user ${userId}`);
}

// ========== Photo Groups (Clustering) ==========

class UnionFind {
  parent: number[];
  rank: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }
  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }
  union(x: number, y: number): void {
    const rx = this.find(x), ry = this.find(y);
    if (rx === ry) return;
    if (this.rank[rx] < this.rank[ry]) { this.parent[rx] = ry; }
    else if (this.rank[rx] > this.rank[ry]) { this.parent[ry] = rx; }
    else { this.parent[ry] = rx; this.rank[rx]++; }
  }
}

const SIMILARITY_THRESHOLD = 0.90;
const TIME_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export async function findPhotoGroupsLogic(userId: number): Promise<FindGroupsResponse> {
  // 1. Get all user photos with timestamps
  const allPhotos = await dbAll<{ id: number; taken_at: string | null; created_at: string | null }>(
    db.select({ id: photos.id, taken_at: photos.taken_at, created_at: photos.created_at })
      .from(photos)
      .where(eq(photos.user_id, userId))
  );

  if (allPhotos.length < 2) {
    return { groups_created: 0, total_photos_grouped: 0 };
  }

  // 2. Fetch DINOv2 embeddings from embedding service
  const photoIds = allPhotos.map((p) => p.id.toString());
  let embeddingMap: Map<number, { embedding: number[]; timestamp: number }>;
  try {
    const response = await fetch(`${EMBEDDING_SERVICE_URL}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: photoIds }),
    });
    if (!response.ok) throw new Error(`Embedding service returned ${response.status}`);
    const data = await response.json() as {
      photos: Array<{ photo_id: string; embedding_dino: number[] | null }>;
    };

    embeddingMap = new Map();
    for (const rec of data.photos) {
      if (!rec.embedding_dino) continue;
      const id = parseInt(rec.photo_id);
      const photo = allPhotos.find((p) => p.id === id);
      const ts = photo ? new Date(photo.taken_at || photo.created_at || 0).getTime() : 0;
      embeddingMap.set(id, { embedding: rec.embedding_dino, timestamp: ts });
    }
  } catch (err: any) {
    console.error("Failed to fetch embeddings:", err.message);
    throw new Error("Embedding service unavailable");
  }

  if (embeddingMap.size < 2) {
    return { groups_created: 0, total_photos_grouped: 0 };
  }

  // 3. Sort by timestamp for windowed comparison
  const indexed = Array.from(embeddingMap.entries())
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => a.timestamp - b.timestamp);

  // 4. Windowed pairwise comparison + Union-Find
  const idToIdx = new Map(indexed.map((item, idx) => [item.id, idx]));
  const uf = new UnionFind(indexed.length);

  for (let i = 0; i < indexed.length; i++) {
    for (let j = i + 1; j < indexed.length; j++) {
      // Stop if outside time window
      if (indexed[j].timestamp - indexed[i].timestamp > TIME_WINDOW_MS) break;

      const sim = cosineSimilarity(indexed[i].embedding, indexed[j].embedding);
      if (sim >= SIMILARITY_THRESHOLD) {
        uf.union(i, j);
      }
    }
  }

  // 5. Collect connected components
  const components = new Map<number, number[]>();
  for (let i = 0; i < indexed.length; i++) {
    const root = uf.find(i);
    if (!components.has(root)) components.set(root, []);
    components.get(root)!.push(i);
  }

  // Filter to groups of 2+
  const groups = Array.from(components.values()).filter((g) => g.length >= 2);

  // 6. Delete old un-reviewed groups, preserve reviewed ones
  const reviewedGroups = await dbAll<{ id: number }>(
    db.select({ id: photoGroups.id })
      .from(photoGroups)
      .where(and(eq(photoGroups.user_id, userId), sql`${photoGroups.reviewed_at} IS NOT NULL`))
  );
  const reviewedIds = new Set(reviewedGroups.map((g) => g.id));

  // Get reviewed group member sets for comparison
  const reviewedMemberSets = new Map<number, Set<number>>();
  for (const gid of reviewedIds) {
    const members = await dbAll<{ photo_id: number }>(
      db.select({ photo_id: photoGroupMembers.photo_id })
        .from(photoGroupMembers)
        .where(eq(photoGroupMembers.group_id, gid))
    );
    reviewedMemberSets.set(gid, new Set(members.map((m) => m.photo_id)));
  }

  // 7. Delete un-reviewed groups and insert new ones atomically to prevent race conditions
  // (concurrent calls can otherwise delete a group between INSERT group and INSERT members)
  const doGroupingWork = async (tx: typeof db | any) => {
    await dbExec(
      tx.delete(photoGroups)
        .where(and(eq(photoGroups.user_id, userId), sql`${photoGroups.reviewed_at} IS NULL`))
    );

    let created = 0;
    let grouped = 0;

    for (const memberIndices of groups) {
      const memberPhotoIds = memberIndices.map((idx) => indexed[idx].id);
      const memberSet = new Set(memberPhotoIds);

      let alreadyReviewed = false;
      for (const [, reviewedSet] of reviewedMemberSets) {
        if (memberSet.size === reviewedSet.size && [...memberSet].every((id) => reviewedSet.has(id))) {
          alreadyReviewed = true;
          break;
        }
      }
      if (alreadyReviewed) continue;

      let bestCenter = memberIndices[0];
      let bestAvgSim = -1;
      for (const i of memberIndices) {
        let totalSim = 0;
        for (const j of memberIndices) {
          if (i !== j) totalSim += cosineSimilarity(indexed[i].embedding, indexed[j].embedding);
        }
        const avgSim = totalSim / (memberIndices.length - 1);
        if (avgSim > bestAvgSim) {
          bestAvgSim = avgSim;
          bestCenter = i;
        }
      }
      const coverPhotoId = indexed[bestCenter].id;

      const centerEmb = indexed[bestCenter].embedding;
      const ranked = memberIndices
        .map((idx) => ({
          photoId: indexed[idx].id,
          sim: cosineSimilarity(indexed[idx].embedding, centerEmb),
        }))
        .sort((a, b) => b.sim - a.sim);

      const group = await dbInsertReturning<{ id: number }>(
        tx.insert(photoGroups)
          .values({ user_id: userId, cover_photo_id: coverPhotoId })
          .returning({ id: photoGroups.id })
      );

      for (let rank = 0; rank < ranked.length; rank++) {
        await dbExec(
          tx.insert(photoGroupMembers).values({
            group_id: group!.id,
            photo_id: ranked[rank].photoId,
            similarity_rank: rank,
          })
        );
      }

      created++;
      grouped += memberIndices.length;
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

export async function reviewPhotoGroupLogic(userId: number, groupId: number): Promise<{ success: boolean }> {
  const group = await dbFirst<{ id: number }>(
    db.select({ id: photoGroups.id })
      .from(photoGroups)
      .where(and(eq(photoGroups.id, groupId), eq(photoGroups.user_id, userId)))
  );

  if (!group) throw new Error("Group not found");

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
): Promise<{ results: PhotoSearchResult[] }> {
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
        .from(faces)
        .where(and(eq(faces.person_id, matchedPerson.id), eq(faces.ignored, false)))
    );
    const uniquePhotoIds = [...new Set(personFaces.map(f => f.photo_id))];
    if (uniquePhotoIds.length === 0) return { results: [] };

    const userPhotos = await dbAll<{ id: number; filename: string; taken_at: string | null; created_at: string }>(
      db.select({ id: photos.id, filename: photos.filename, taken_at: photos.taken_at, created_at: photos.created_at })
        .from(photos)
        .where(and(eq(photos.user_id, userId), inArray(photos.id, uniquePhotoIds)))
    );
    return {
      results: userPhotos.map(p => ({
        photoId: p.id,
        score: 1.0,
        filename: p.filename,
        taken_at: p.taken_at ?? undefined,
        created_at: p.created_at,
      })),
    };
  }

  // 1. Call embedding service text search
  let embeddingResults: Array<{ photo_id: string; score: number }>;
  try {
    const response = await fetch(`${EMBEDDING_SERVICE_URL}/search/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, k: limit, threshold }),
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
    return { results: [] };
  }

  // 2. Map numeric photo IDs and verify ownership
  const photoIdNumbers = embeddingResults
    .map(r => parseInt(r.photo_id, 10))
    .filter(id => !isNaN(id));

  const userPhotos = await dbAll<{ id: number; filename: string; taken_at: string | null; created_at: string }>(
    db.select({ id: photos.id, filename: photos.filename, taken_at: photos.taken_at, created_at: photos.created_at })
      .from(photos)
      .where(and(eq(photos.user_id, userId), inArray(photos.id, photoIdNumbers)))
  );

  const photoMap = new Map(userPhotos.map(p => [p.id, p]));

  // 3. Build results preserving embedding score order
  const results: PhotoSearchResult[] = [];
  for (const r of embeddingResults) {
    const id = parseInt(r.photo_id, 10);
    const photo = photoMap.get(id);
    if (!photo) continue; // skip photos not belonging to user
    results.push({
      photoId: photo.id,
      score: r.score,
      filename: photo.filename,
      taken_at: photo.taken_at ?? undefined,
      created_at: photo.created_at,
    });
  }

  return { results };
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
    auto_crop: { x: number; y: number } | null;
  }>(
    db.select({
      id: photos.id, user_id: photos.user_id, filename: photos.filename,
      original_name: photos.original_name, mime_type: photos.mime_type,
      size: photos.size, hash: photos.hash, taken_at: photos.taken_at,
      created_at: photos.created_at, curation_status: photoCuration.status,
      latitude: photos.latitude, longitude: photos.longitude,
      location_city: photos.location_city, location_country: photos.location_country,
      location_name: photos.location_name, auto_crop: photos.auto_crop,
    })
    .from(photos)
    .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
    .where(and(...conditions))
    .orderBy(photoDateOrder)
    .limit(params.limit ?? 200)
  );

  return {
    photos: rows.map(r => ({
      id: r.id, user_id: r.user_id, filename: r.filename, original_name: r.original_name,
      mime_type: r.mime_type, size: r.size, hash: r.hash ?? undefined,
      taken_at: r.taken_at ?? undefined, created_at: r.created_at ?? "",
      curation_status: (r.curation_status as CurationStatus) ?? "visible",
      latitude: r.latitude ?? undefined, longitude: r.longitude ?? undefined,
      location_city: r.location_city ?? undefined, location_country: r.location_country ?? undefined,
      location_name: r.location_name ?? undefined, auto_crop: r.auto_crop ?? undefined,
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
    auto_crop: { x: number; y: number } | null;
  }>(
    db.select({
      id: photos.id, user_id: photos.user_id, filename: photos.filename,
      original_name: photos.original_name, mime_type: photos.mime_type,
      size: photos.size, hash: photos.hash, taken_at: photos.taken_at,
      created_at: photos.created_at, curation_status: photoCuration.status,
      latitude: photos.latitude, longitude: photos.longitude,
      location_city: photos.location_city, location_country: photos.location_country,
      location_name: photos.location_name, auto_crop: photos.auto_crop,
    })
    .from(photos)
    .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
    .where(and(...conditions))
    .orderBy(photoDateOrder)
    .limit(params.limit ?? 200)
  );

  return {
    photos: rows.map(r => ({
      id: r.id, user_id: r.user_id, filename: r.filename, original_name: r.original_name,
      mime_type: r.mime_type, size: r.size, hash: r.hash ?? undefined,
      taken_at: r.taken_at ?? undefined, created_at: r.created_at ?? "",
      curation_status: (r.curation_status as CurationStatus) ?? "visible",
      latitude: r.latitude ?? undefined, longitude: r.longitude ?? undefined,
      location_city: r.location_city ?? undefined, location_country: r.location_country ?? undefined,
      location_name: r.location_name ?? undefined, auto_crop: r.auto_crop ?? undefined,
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

  const response = await fetch(`${LANDMARK_SERVICE_URL}/detect-landmarks`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Landmark service returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<{ landmarks: Array<{ label: string; confidence: number; bbox: { x: number; y: number; width: number; height: number } }> }>;
}

export async function indexPhotoLandmarks(userId: number, photoId: number): Promise<void> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );
  if (!photo) return;

  const filePath = path.join(UPLOAD_DIR, photo.filename);
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
    if (result.landmarks.length > 0) {
      await dbExec(db.delete(photoLandmarks).where(eq(photoLandmarks.photo_id, photoId)));
      for (const lm of result.landmarks) {
        await dbExec(
          db.insert(photoLandmarks).values({
            photo_id: photoId,
            user_id: userId,
            label: lm.label,
            confidence: lm.confidence,
            bbox: JSON.stringify(lm.bbox),
          })
        );
      }
      console.log(`Stored ${result.landmarks.length} landmarks for photo ${photoId}`);
    }
  } catch (err) {
    console.error(`Landmark detection failed for photo ${photoId}:`, err);
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }

  // Recompute auto-crop focus point (landmarks as fallback if no faces)
  try {
    await computeAndStoreAutoCrop(userId, photoId);
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

export async function indexPhotoQuality(userId: number, photoId: number): Promise<void> {
  if (!ENABLE_QUALITY) return;

  // If face detection is enabled, wait until its job is no longer active before
  // scoring.  Throwing DeferJobError puts this job back to pending so it is
  // retried on the next worker poll cycle — no double CLIP call needed.
  if (ENABLE_LOCAL_FACES) {
    const faceJobRow = await dbFirst<{ status: string }>(
      db.select({ status: photoScanQueue.status })
        .from(photoScanQueue)
        .where(and(
          eq(photoScanQueue.photo_id, photoId),
          eq(photoScanQueue.service, "face_detection"),
        ))
    );
    // Defer only when a face job actively exists but hasn't finished yet.
    // If no job exists, or it is done/failed, proceed so quality scoring is
    // never blocked indefinitely.
    if (faceJobRow && (faceJobRow.status === "pending" || faceJobRow.status === "processing")) {
      throw new DeferJobError("waiting for face_detection to complete");
    }
  }

  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );
  if (!photo) return;

  const filePath = path.join(UPLOAD_DIR, photo.filename);
  if (!fs.existsSync(filePath)) return;

  let processingPath = filePath;
  let tempPath: string | null = null;

  // HEIC files must be converted before sending to the embedding service
  const ext = path.extname(photo.filename).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    try {
      tempPath = path.join(UPLOAD_DIR, `temp_q_${photoId}_${Date.now()}.jpg`);
      await sharp(filePath).jpeg({ quality: 100 }).toFile(tempPath);
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
        .where(and(eq(faces.photo_id, photoId), eq(faces.ignored, false)))
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

    const response = await fetch(`${EMBEDDING_SERVICE_URL}/quality`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Quality service returned ${response.status} for photo ${photoId}: ${errorText}`);
      return;
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
      .where(and(eq(photos.id, photoId), eq(photos.user_id, userId)));

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
  const photo = await dbFirst<{ id: number; location_name: string | null; location_city: string | null; location_country: string | null }>(
    db.select({ id: photos.id, location_name: photos.location_name, location_city: photos.location_city, location_country: photos.location_country })
      .from(photos)
      .where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );
  if (!photo) throw new Error("Photo not found");

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
  const lmRows = await dbAll<{ photo_id: number; label: string; confidence: number; bbox: string }>(
    db.select({
      photo_id: photoLandmarks.photo_id,
      label: photoLandmarks.label,
      confidence: photoLandmarks.confidence,
      bbox: photoLandmarks.bbox,
    })
    .from(photoLandmarks)
    .where(and(eq(photoLandmarks.user_id, userId), ilike(photoLandmarks.label, `%${query}%`)))
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
  const parsed = parseNaturalQueryInternal(query);
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

  // Case B: semantic only, no structural filters → pure CLIP
  if (!hasStructuredFilter) {
    const response = await fetch(`${EMBEDDING_SERVICE_URL}/search/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: parsed.semanticQuery, k: limit, threshold }),
    });
    if (!response.ok) throw new Error(`Embedding service error: ${response.status}`);
    const clipData = await response.json() as { results: Array<{ photo_id: string; score: number }> };
    const ids = clipData.results.map(r => parseInt(r.photo_id, 10)).filter(id => !isNaN(id));
    if (ids.length === 0) return { results: [], parsed: parsedPublic };
    const rows = await dbAll<PhotoRow>(
      db.select(selectFields).from(photos)
        .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
        .where(and(eq(photos.user_id, userId), inArray(photos.id, ids)))
    );
    const photoMap = new Map(rows.map(p => [p.id, p]));
    return {
      parsed: parsedPublic,
      results: clipData.results
        .map(r => { const p = photoMap.get(parseInt(r.photo_id, 10)); return p ? toResult(p, r.score) : null; })
        .filter((r): r is NaturalSearchResult => r !== null),
    };
  }

  // Case C: semantic + structural filters → CLIP results intersected with DB filter
  // Pre-fetch candidate IDs matching date + location constraints
  const candidateRows = await dbAll<{ id: number }>(
    db.select({ id: photos.id })
      .from(photos)
      .leftJoin(photoCuration, and(eq(photoCuration.photo_id, photos.id), eq(photoCuration.user_id, userId)))
      .where(and(...dbConditions))
  );
  const candidateSet = new Set(candidateRows.map(r => r.id));
  if (candidateSet.size === 0) return { results: [], parsed: parsedPublic };

  // Request enlarged k so intersection still yields enough results
  const clipK = Math.min(candidateSet.size, limit * 5);
  const response = await fetch(`${EMBEDDING_SERVICE_URL}/search/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: parsed.semanticQuery, k: clipK, threshold }),
  });
  if (!response.ok) throw new Error(`Embedding service error: ${response.status}`);
  const clipData = await response.json() as { results: Array<{ photo_id: string; score: number }> };

  // Keep only CLIP results that also match the structural filter
  const intersected = clipData.results
    .filter(r => candidateSet.has(parseInt(r.photo_id, 10)))
    .slice(0, limit);
  if (intersected.length === 0) return { results: [], parsed: parsedPublic };

  const ids = intersected.map(r => parseInt(r.photo_id, 10));
  const rows = await dbAll<PhotoRow>(
    db.select(selectFields).from(photos)
      .where(and(eq(photos.user_id, userId), inArray(photos.id, ids)))
  );
  const photoMap = new Map(rows.map(p => [p.id, p]));

  return {
    parsed: parsedPublic,
    results: intersected
      .map(r => { const p = photoMap.get(parseInt(r.photo_id, 10)); return p ? toResult(p, r.score) : null; })
      .filter((r): r is NaturalSearchResult => r !== null),
  };
}
