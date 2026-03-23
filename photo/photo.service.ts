import fs from "fs";
import path from "path";
import crypto from "crypto";
import exifr from "exifr";
import { exiftool } from "exiftool-vendored";
import { eq, and, or, sql, inArray } from "drizzle-orm";
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
} from "../db/schema";
import type {
  Photo,
  PhotoWithCuration,
  CurationStatus,
  Album,
  AlbumWithPhotos,
  CreateAlbumRequest,
  UpdateAlbumRequest,
  AddPhotoToAlbumRequest,
  ShareAlbumRequest,
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
} from "../db/types";
import heicConvert from "heic-convert";

const isPg = process.env.DB_TYPE?.toLowerCase() === 'postgres'
const nowSql = isPg ? sql`NOW()` : sql`datetime('now')`

export const UPLOAD_DIR = path.resolve(process.env.PHOTO_UPLOAD_DIR || "uploads/photos");
const INSIGHTFACE_SERVICE_URL = process.env.INSIGHTFACE_SERVICE_URL || "http://localhost:8000";
const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || "http://localhost:8001";

// Distance threshold for face matching.
// InsightFace uses cosine similarity (higher is better, 1.0 is identical).
// We convert it to a "distance" if we want, or just use similarity directly.
// The config value is now treated as minimum similarity for a match.
const FACE_SIMILARITY_THRESHOLD = parseFloat(process.env.FACE_DISTANCE_THRESHOLD || "0.45");
export const ENABLE_LOCAL_FACES = process.env.ENABLE_LOCAL_FACES === "true";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ---------- People & Faces ----------

async function callInsightFaceDetect(filePath: string): Promise<{ faces: any[], width: number, height: number }> {
  const formData = new FormData();
  const fileData = await fs.promises.readFile(filePath);
  const blob = new Blob([fileData], { type: 'image/jpeg' });
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
  metadata: { timestamp?: string; camera_id?: string; face_ids?: string[] }
): Promise<void> {
  const formData = new FormData();
  const fileData = await fs.promises.readFile(filePath);
  const blob = new Blob([fileData], { type: 'image/jpeg' });
  
  formData.append('file', blob, path.basename(filePath));
  formData.append('photo_id', photoId);
  formData.append('file_path', filePath);
  if (metadata.timestamp) formData.append('timestamp', metadata.timestamp);
  if (metadata.camera_id) formData.append('camera_id', metadata.camera_id);
  if (metadata.face_ids && metadata.face_ids.length > 0) {
    formData.append('face_ids', metadata.face_ids.join(','));
  }

  const response = await fetch(`${EMBEDDING_SERVICE_URL}/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Embedding service returned ${response.status}: ${errorText}`);
    // Don't throw, just log for now to not break the upload flow
  } else {
    console.log(`Successfully uploaded photo ${photoId} to embedding service.`);
  }
}

export async function indexPhotoEmbeddings(userId: number, photoId: number): Promise<void> {
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
  });
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

  // Check if it's a HEIC file
  const ext = path.extname(photo.filename).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    try {
      const inputBuffer = await fs.promises.readFile(filePath);
      const outputBuffer = await heicConvert({
        buffer: inputBuffer,
        format: 'JPEG',
        quality: 1
      });
      tempPath = path.join(UPLOAD_DIR, `temp_${photoId}_${Date.now()}.jpg`);
      await fs.promises.writeFile(tempPath, outputBuffer as Buffer);
      processingPath = tempPath;
    } catch (err) {
      console.error(`Error converting HEIC photo ${photoId}:`, err);
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
}

async function getExifDate(filePath: string): Promise<string | null> {
  try {
    const data = await exifr.parse(filePath);
    if (data && data.DateTimeOriginal) {
      return new Date(data.DateTimeOriginal).toISOString();
    }
    if (data && data.CreateDate) {
        return new Date(data.CreateDate).toISOString();
    }
  } catch (err) {
    console.error("Error parsing EXIF data:", err);
  }
  return null;
}

// ---------- Photos ----------

export async function uploadPhotoStream(
  userId: number,
  stream: IncomingMessage,
  originalName: string,
  mimeType: string
): Promise<Photo> {
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

  // Extraction of EXIF data after the file is saved
  const takenAt = await getExifDate(filePath);

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
      taken_at: takenAt,
    }).returning()
  );

  if (ENABLE_LOCAL_FACES) {
    // Run face detection in background
    indexPhotoFaces(userId, row!.id).catch(err => {
        console.error("Face indexing error:", err);
    });
  }

  // Run embedding generation in background, then re-group similar photos
  indexPhotoEmbeddings(userId, row!.id)
    .then(() => findPhotoGroupsLogic(userId))
    .catch(err => {
      console.error("Embedding/grouping error:", err);
    });

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
  };
}

export async function uploadPhotoLogic(
  userId: number,
  file: { data: Buffer; name: string; mimeType: string }
): Promise<Photo> {
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

  // Extraction of EXIF data
  const takenAt = await getExifDate(filePath);

  const row2 = await dbInsertReturning<typeof photos.$inferSelect>(
    db.insert(photos).values({
      user_id: userId,
      filename: filename,
      original_name: file.name,
      mime_type: file.mimeType,
      size: file.data.length,
      hash: digest,
      taken_at: takenAt,
    }).returning()
  );

  if (ENABLE_LOCAL_FACES) {
    // Run face detection in background
    indexPhotoFaces(userId, row2!.id).catch(err => {
        console.error("Face indexing error:", err);
    });
  }

  // Run embedding generation in background, then re-group similar photos
  indexPhotoEmbeddings(userId, row2!.id)
    .then(() => findPhotoGroupsLogic(userId))
    .catch(err => {
      console.error("Embedding/grouping error:", err);
    });

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
  };
}

export async function listPhotosLogic(userId: number, showHidden: boolean = false): Promise<ListPhotosResponse> {
  const rows = await dbAll<{
    id: number; user_id: number; filename: string; original_name: string;
    mime_type: string; size: number; hash: string | null; taken_at: string | null;
    created_at: string | null; curation_status: string | null;
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
      })
      .from(photos)
      .leftJoin(
        photoCuration,
        and(eq(photos.id, photoCuration.photo_id), eq(photoCuration.user_id, userId))
      )
      .where(eq(photos.user_id, userId))
      .orderBy(sql`COALESCE(${photos.taken_at}, ${photos.created_at}) DESC`)
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
        set: { status: "hidden", updated_at: new Date().toISOString() },
      })
  );

  return { success: true, message: "Photo hidden" };
}

export async function hardDeletePhotoLogic(userId: number, photoId: number): Promise<DeleteResponse> {
  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );

  if (!photo) {
    throw new Error("Photo not found or unauthorized");
  }

  // Delete file from disk
  const filePath = path.join(UPLOAD_DIR, photo.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  // Hard delete from DB (cascades to curation, faces, album_photos, group_members)
  await dbExec(db.delete(photos).where(eq(photos.id, photoId)));

  return { success: true, message: "Photo permanently deleted" };
}

export async function updatePhotoCurationLogic(
  userId: number,
  photoId: number,
  status: CurationStatus
): Promise<{ success: boolean }> {
  const photo = await dbFirst<{ id: number }>(
    db.select({ id: photos.id }).from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
  );

  if (!photo) {
    throw new Error("Photo not found or unauthorized");
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
          set: { status, updated_at: new Date().toISOString() },
        })
    );
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

  // 1. Update database
  await dbExec(db.update(photos).set({ taken_at: takenAt }).where(eq(photos.id, photoId)));

  // 2. Update file metadata
  try {
    const date = new Date(takenAt);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const formattedDate = `${year}:${month}:${day} ${hours}:${minutes}:${seconds}`;

    // Write to multiple tags to ensure compatibility
    await exiftool.write(filePath, {
      DateTimeOriginal: formattedDate,
      CreateDate: formattedDate,
      ModifyDate: formattedDate,
    }, ["-overwrite_original"]);
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
  const inputBuffer = await fs.promises.readFile(filePath);
  const outputBuffer = await heicConvert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: 0.9
  });
  return outputBuffer as Buffer;
}

// ---------- Albums ----------

export async function createAlbumLogic(userId: number, req: CreateAlbumRequest): Promise<Album> {
  const row = await dbInsertReturning<typeof albums.$inferSelect>(
    db.insert(albums).values({ user_id: userId, name: req.name }).returning()
  );

  return {
    id: row!.id,
    user_id: row!.user_id,
    name: row!.name,
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

  const rows = await dbAll<typeof albums.$inferSelect>(
    db.select().from(albums).where(or(eq(albums.user_id, userId), sharedAlbumIds.length > 0 ? inArray(albums.id, sharedAlbumIds) : undefined))
  );

  return {
    albums: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      name: r.name,
      created_at: r.created_at ?? "",
      updated_at: r.updated_at ?? "",
    })),
  };
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

  const photoRows = await dbAll<{
    id: number; user_id: number; filename: string; original_name: string;
    mime_type: string; size: number; hash: string | null; taken_at: string | null; created_at: string | null;
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
      })
      .from(photos)
      .innerJoin(albumPhotos, eq(albumPhotos.photo_id, photos.id))
      .where(eq(albumPhotos.album_id, albumId))
  );

  return {
    id: album.id,
    user_id: album.user_id,
    name: album.name,
    created_at: album.created_at ?? "",
    updated_at: album.updated_at ?? "",
    photos: photoRows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      filename: r.filename,
      original_name: r.original_name,
      mime_type: r.mime_type,
      size: r.size,
      hash: r.hash ?? undefined,
      taken_at: r.taken_at ?? undefined,
      created_at: r.created_at ?? "",
    })),
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

  await dbExec(
    db.update(albums).set({ name: req.name, updated_at: new Date().toISOString() }).where(eq(albums.id, req.id))
  );

  const updated = (await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, req.id))
  ))!;
  return {
    id: updated.id,
    user_id: updated.user_id,
    name: updated.name,
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
    db.insert(albumPhotos).values({ album_id: req.albumId, photo_id: req.photoId })
  );

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
    db.insert(albumShares).values({ album_id: req.albumId, user_id: req.userId, access_level: req.accessLevel })
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
            AND f.ignored = 0
          ORDER BY COALESCE(p.taken_at, p.created_at) DESC NULLS LAST, f.id DESC
          LIMIT 1
        ),
        persons.cover_face_id
      )`,
      created_at: persons.created_at,
      updated_at: persons.updated_at,
      faceCount: sql<number>`CAST(COALESCE((SELECT count(*) FROM faces f WHERE f.person_id = persons.id), 0) AS INTEGER)`,
      cover_filename: sql<string>`COALESCE(
        (
          SELECT p.filename
          FROM faces f
          INNER JOIN photos p ON p.id = f.photo_id
          WHERE f.person_id = persons.id
            AND f.user_id = persons.user_id
            AND f.ignored = 0
          ORDER BY COALESCE(p.taken_at, p.created_at) DESC NULLS LAST, f.id DESC
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
            AND f.ignored = 0
          ORDER BY COALESCE(p.taken_at, p.created_at) DESC NULLS LAST, f.id DESC
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
      .orderBy(sql`COALESCE(${photos.taken_at}, ${photos.created_at}) DESC NULLS LAST`, sql`${faces.id} DESC`)
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
        faceCount: sql<number>`CAST(COALESCE((SELECT count(*) FROM faces f WHERE f.person_id = persons.id), 0) AS INTEGER)`,
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
  await indexPhotoEmbeddings(userId, photoId);
  return { success: true };
}

// In-memory reindex progress per user
interface ReindexState {
  inProgress: boolean;
  total: number;
  processed: number;
  errors: number;
}
const reindexStateMap = new Map<number, ReindexState>();

export function getReindexStatusForUser(userId: number): ReindexState {
  return reindexStateMap.get(userId) ?? { inProgress: false, total: 0, processed: 0, errors: 0 };
}

export async function reindexAllPhotosLogic(userId: number): Promise<{ count: number }> {
  const existing = reindexStateMap.get(userId);
  if (existing?.inProgress) {
    throw new Error("Reindex already in progress");
  }

  const allPhotos = await dbAll<{ id: number }>(
    db.select({ id: photos.id }).from(photos).where(eq(photos.user_id, userId))
  );

  const state: ReindexState = { inProgress: true, total: allPhotos.length, processed: 0, errors: 0 };
  reindexStateMap.set(userId, state);

  console.log(`Starting re-index for ${allPhotos.length} photos for user ${userId}`);

  // Process sequentially in background to avoid race conditions
  // (concurrent processing deletes all faces before new ones are created,
  //  breaking person matching)
  (async () => {
    for (const p of allPhotos) {
      try {
        await indexPhotoFaces(userId, p.id, false);
        await indexPhotoEmbeddings(userId, p.id);
        state.processed++;
      } catch (err: any) {
        state.errors++;
        if (err.message && err.message.includes("FACE_MODELS_NOT_LOADED")) {
          console.error(`Skipping reindex for photo ${p.id}: Modelle nicht geladen.`);
        } else {
          console.error(`Error reindexing photo ${p.id}:`, err);
        }
      }
    }
    // Clean up orphaned persons (persons with 0 associated faces)
    cleanupOrphanedPersons(userId);
    state.inProgress = false;
    console.log(`Re-index complete for user ${userId}: ${state.processed} processed, ${state.errors} errors, orphaned persons cleaned up.`);
  })();

  return { count: allPhotos.length };
}

/**
 * Remove persons that have no associated faces (orphaned after re-indexing).
 */
async function cleanupOrphanedPersons(userId: number): Promise<void> {
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

  // Delete un-reviewed groups
  await dbExec(
    db.delete(photoGroups)
      .where(and(eq(photoGroups.user_id, userId), sql`${photoGroups.reviewed_at} IS NULL`))
  );

  // 7. Insert new groups (skip if matching a reviewed group)
  let groupsCreated = 0;
  let totalPhotosGrouped = 0;

  for (const memberIndices of groups) {
    const memberPhotoIds = memberIndices.map((idx) => indexed[idx].id);
    const memberSet = new Set(memberPhotoIds);

    // Check if this group matches an existing reviewed group
    let alreadyReviewed = false;
    for (const [, reviewedSet] of reviewedMemberSets) {
      // Consider it a match if sets are identical
      if (memberSet.size === reviewedSet.size && [...memberSet].every((id) => reviewedSet.has(id))) {
        alreadyReviewed = true;
        break;
      }
    }
    if (alreadyReviewed) continue;

    // Compute center photo (highest avg similarity to others in group)
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

    // Sort members by similarity to center (descending)
    const centerEmb = indexed[bestCenter].embedding;
    const ranked = memberIndices
      .map((idx) => ({
        photoId: indexed[idx].id,
        sim: cosineSimilarity(indexed[idx].embedding, centerEmb),
      }))
      .sort((a, b) => b.sim - a.sim);

    // Insert group
    const group = await dbInsertReturning<{ id: number }>(
      db.insert(photoGroups)
        .values({ user_id: userId, cover_photo_id: coverPhotoId })
        .returning({ id: photoGroups.id })
    );

    // Insert members with similarity rank
    for (let rank = 0; rank < ranked.length; rank++) {
      await dbExec(
        db.insert(photoGroupMembers).values({
          group_id: group!.id,
          photo_id: ranked[rank].photoId,
          similarity_rank: rank,
        })
      );
    }

    groupsCreated++;
    totalPhotosGrouped += memberIndices.length;
  }

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
