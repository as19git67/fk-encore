import fs from "fs";
import path from "path";
import crypto from "crypto";
import exifr from "exifr";
import { exiftool } from "exiftool-vendored";
import { eq, and, or, sql, inArray } from "drizzle-orm";
import db from "../db/database";
import type { IncomingMessage } from "http";
import { pipeline } from "stream/promises";
import {
  photos,
  albums,
  albumPhotos,
  albumShares,
  persons,
  faces,
} from "../db/schema";
import type {
  Photo,
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
  PhotoGroupsResponse,
  SimilarPersonPair,
  PhotoGroup,
} from "../db/types";
import heicConvert from "heic-convert";

export const UPLOAD_DIR = path.resolve(process.env.PHOTO_UPLOAD_DIR || "uploads/photos");
const INSIGHTFACE_SERVICE_URL = process.env.INSIGHTFACE_SERVICE_URL || "http://localhost:8000";

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

export async function indexPhotoFaces(userId: number, photoId: number, resetIgnored: boolean = false): Promise<void> {
  if (!ENABLE_LOCAL_FACES) {
    console.log("Local face indexing is disabled via ENABLE_LOCAL_FACES=false");
    return;
  }

  const photo = db
    .select()
    .from(photos)
    .where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
    .get();
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
  const ignoredFaces = resetIgnored ? [] : db.select().from(faces).where(and(eq(faces.photo_id, photoId), eq(faces.ignored, true))).all();

  // Remove faces for this photo
  if (resetIgnored) {
    // Remove ALL faces (including ignored ones)
    db.delete(faces).where(eq(faces.photo_id, photoId)).run();
  } else {
    // Only remove non-ignored faces
    db.delete(faces).where(and(eq(faces.photo_id, photoId), eq(faces.ignored, false))).run();
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
        const newPerson = db
          .insert(persons)
          .values({
            user_id: userId,
            name: "Unbenannt",
          })
          .returning()
          .get();
        personId = newPerson.id;
      }

      const faceResult = db.insert(faces)
        .values({
          user_id: userId,
          photo_id: photoId,
          bbox: JSON.stringify(bbox),
          embedding: JSON.stringify(embedding),
          person_id: personId,
          quality: 100, 
        })
        .returning()
        .get();

      // Set cover_face_id if not set for person OR if it refers to a non-existent face
      const currentPerson = db.select().from(persons).where(eq(persons.id, personId)).get();
      let needsCoverUpdate = false;
      if (currentPerson) {
          if (!currentPerson.cover_face_id) {
              needsCoverUpdate = true;
          } else {
              const coverFaceExists = db.select({ id: faces.id }).from(faces).where(eq(faces.id, currentPerson.cover_face_id)).get();
              if (!coverFaceExists) {
                  needsCoverUpdate = true;
              }
          }
      }

      if (needsCoverUpdate) {
          db.update(persons).set({ 
              cover_face_id: faceResult.id,
              updated_at: sql`datetime('now')`
          }).where(eq(persons.id, personId)).run();
      } else {
          db.update(persons).set({ 
              updated_at: sql`datetime('now')`
          }).where(eq(persons.id, personId)).run();
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
  const existing = db
    .select()
    .from(photos)
    .where(and(eq(photos.user_id, userId), eq(photos.hash, digest)))
    .get();

  if (existing) {
    // Delete the temporary file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    throw new Error("PHOTO_ALREADY_EXISTS");
  }

  const row = db
    .insert(photos)
    .values({
      user_id: userId,
      filename: filename,
      original_name: originalName,
      mime_type: mimeType,
      size: size,
      hash: digest,
      taken_at: takenAt,
    })
    .returning()
    .get();

  if (ENABLE_LOCAL_FACES) {
    // Run face detection in background
    indexPhotoFaces(userId, row.id).catch(err => {
        console.error("Face indexing error:", err);
    });
  }

  return {
    id: row.id,
    user_id: row.user_id,
    filename: row.filename,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size: row.size,
    hash: row.hash ?? undefined,
    taken_at: row.taken_at ?? undefined,
    created_at: row.created_at ?? "",
  };
}

export async function uploadPhotoLogic(
  userId: number,
  file: { data: Buffer; name: string; mimeType: string }
): Promise<Photo> {
  const digest = crypto.createHash('sha256').update(file.data).digest('hex');

  // Check for duplicate for this user
  const existing = db
    .select()
    .from(photos)
    .where(and(eq(photos.user_id, userId), eq(photos.hash, digest)))
    .get();

  if (existing) {
    throw new Error("PHOTO_ALREADY_EXISTS");
  }

  const filename = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}${path.extname(file.name)}`;
  const filePath = path.join(UPLOAD_DIR, filename);

  fs.writeFileSync(filePath, file.data);

  // Extraction of EXIF data
  const takenAt = await getExifDate(filePath);

  const row = db
    .insert(photos)
    .values({
      user_id: userId,
      filename: filename,
      original_name: file.name,
      mime_type: file.mimeType,
      size: file.data.length,
      hash: digest,
      taken_at: takenAt,
    })
    .returning()
    .get();

  if (ENABLE_LOCAL_FACES) {
    // Run face detection in background
    indexPhotoFaces(userId, row.id).catch(err => {
        console.error("Face indexing error:", err);
    });
  }

  return {
    id: row.id,
    user_id: row.user_id,
    filename: row.filename,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size: row.size,
    hash: row.hash ?? undefined,
    taken_at: row.taken_at ?? undefined,
    created_at: row.created_at ?? "",
  };
}

export function listPhotosLogic(userId: number): ListPhotosResponse {
  const rows = db
    .select()
    .from(photos)
    .where(eq(photos.user_id, userId))
    .orderBy(sql`COALESCE(${photos.taken_at}, ${photos.created_at}) DESC`)
    .all();

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
    })),
  };
}

export function deletePhotoLogic(userId: number, photoId: number): DeleteResponse {
  const photo = db
    .select()
    .from(photos)
    .where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
    .get();

  if (!photo) {
    throw new Error("Photo not found or unauthorized");
  }

  // Delete file
  const filePath = path.join(UPLOAD_DIR, photo.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  db.delete(photos).where(eq(photos.id, photoId)).run();

  return { success: true, message: "Photo deleted" };
}

export function getPhotosToRefreshMetadataLogic(userId: number): { ids: number[] } {
  const rows = db
    .select({ id: photos.id })
    .from(photos)
    .where(eq(photos.user_id, userId))
    .all();

  return { ids: rows.map((r) => r.id) };
}

export async function refreshPhotoMetadataLogic(userId: number, photoId: number): Promise<{ success: boolean; taken_at?: string }> {
  const photo = db
    .select()
    .from(photos)
    .where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
    .get();

  if (!photo) {
    throw new Error("Photo not found or unauthorized");
  }

  const filePath = path.join(UPLOAD_DIR, photo.filename);
  if (!fs.existsSync(filePath)) {
    throw new Error("File not found on disk");
  }

  const takenAt = await getExifDate(filePath);

  // Always update, even if takenAt is null (to sync with current logic if it was different before)
  db.update(photos)
    .set({ taken_at: takenAt })
    .where(eq(photos.id, photoId))
    .run();

  return { success: true, taken_at: takenAt ?? undefined };
}

export async function updatePhotoDateLogic(
  userId: number,
  photoId: number,
  takenAt: string
): Promise<{ success: boolean; taken_at: string }> {
  const photo = db
    .select()
    .from(photos)
    .where(and(eq(photos.id, photoId), eq(photos.user_id, userId)))
    .get();

  if (!photo) {
    throw new Error("Photo not found or unauthorized");
  }

  const filePath = path.join(UPLOAD_DIR, photo.filename);
  if (!fs.existsSync(filePath)) {
    throw new Error("File not found on disk");
  }

  // 1. Update database
  db.update(photos)
    .set({ taken_at: takenAt })
    .where(eq(photos.id, photoId))
    .run();

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

export function createAlbumLogic(userId: number, req: CreateAlbumRequest): Album {
  const row = db
    .insert(albums)
    .values({
      user_id: userId,
      name: req.name,
    })
    .returning()
    .get();

  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

export function listAlbumsLogic(userId: number): ListAlbumsResponse {
  // Albums owned by user OR shared with user
  const sharedAlbumIds = db
    .select({ album_id: albumShares.album_id })
    .from(albumShares)
    .where(eq(albumShares.user_id, userId))
    .all()
    .map((s) => s.album_id);

  let query = db.select().from(albums).where(or(eq(albums.user_id, userId), sharedAlbumIds.length > 0 ? inArray(albums.id, sharedAlbumIds) : undefined));

  const rows = query.all();

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

export function getAlbumLogic(userId: number, albumId: number): AlbumWithPhotos {
  const album = db.select().from(albums).where(eq(albums.id, albumId)).get();

  if (!album) {
    throw new Error("Album not found");
  }

  // Check access
  const isOwner = album.user_id === userId;
  const share = db
    .select()
    .from(albumShares)
    .where(and(eq(albumShares.album_id, albumId), eq(albumShares.user_id, userId)))
    .get();

  if (!isOwner && !share) {
    throw new Error("Unauthorized access to album");
  }

  const photoRows = db
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
    .all();

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

export function updateAlbumLogic(userId: number, req: UpdateAlbumRequest): Album {
  const album = db.select().from(albums).where(eq(albums.id, req.id)).get();
  if (!album) throw new Error("Album not found");

  // Check write access
  const isOwner = album.user_id === userId;
  const share = db
    .select()
    .from(albumShares)
    .where(and(eq(albumShares.album_id, req.id), eq(albumShares.user_id, userId)))
    .get();

  if (!isOwner && (!share || share.access_level !== "write")) {
    throw new Error("Unauthorized to update album");
  }

  db.update(albums)
    .set({ name: req.name, updated_at: sql`datetime('now')` })
    .where(eq(albums.id, req.id))
    .run();

  const updated = db.select().from(albums).where(eq(albums.id, req.id)).get()!;
  return {
    id: updated.id,
    user_id: updated.user_id,
    name: updated.name,
    created_at: updated.created_at ?? "",
    updated_at: updated.updated_at ?? "",
  };
}

export function deleteAlbumLogic(userId: number, albumId: number): DeleteResponse {
  const album = db.select().from(albums).where(eq(albums.id, albumId)).get();
  if (!album) throw new Error("Album not found");

  if (album.user_id !== userId) {
    throw new Error("Only owner can delete album");
  }

  db.delete(albums).where(eq(albums.id, albumId)).run();
  return { success: true, message: "Album deleted" };
}

export function addPhotoToAlbumLogic(userId: number, req: AddPhotoToAlbumRequest): { success: boolean } {
  const album = db.select().from(albums).where(eq(albums.id, req.albumId)).get();
  if (!album) throw new Error("Album not found");

  // Check write access
  const isOwner = album.user_id === userId;
  const share = db
    .select()
    .from(albumShares)
    .where(and(eq(albumShares.album_id, req.albumId), eq(albumShares.user_id, userId)))
    .get();

  if (!isOwner && (!share || share.access_level !== "write")) {
    throw new Error("Unauthorized to add photos to album");
  }

  // Photo must be accessible to user (either owner or album is shared - wait, photo ownership is separate)
  // For now, let's say user can only add their OWN photos to albums they have write access to.
  const photo = db.select().from(photos).where(eq(photos.id, req.photoId)).get();
  if (!photo || photo.user_id !== userId) {
    throw new Error("Photo not found or not owned by user");
  }

  db.insert(albumPhotos)
    .values({
      album_id: req.albumId,
      photo_id: req.photoId,
    })
    .run();

  return { success: true };
}

export function shareAlbumLogic(userId: number, req: ShareAlbumRequest): { success: boolean } {
  const album = db.select().from(albums).where(eq(albums.id, req.albumId)).get();
  if (!album) throw new Error("Album not found");

  if (album.user_id !== userId) {
    throw new Error("Only owner can share album");
  }

  db.insert(albumShares)
    .values({
      album_id: req.albumId,
      user_id: req.userId,
      access_level: req.accessLevel,
    })
    .run();
  return { success: true };
}

async function findBestPersonMatch(
  userId: number,
  embedding: number[]
): Promise<{ personId: number; distance: number } | null> {
  const allFaces = db
    .select({
      person_id: faces.person_id,
      embedding: faces.embedding,
    })
    .from(faces)
    .where(and(eq(faces.user_id, userId), sql`${faces.person_id} IS NOT NULL`, eq(faces.ignored, false)))
    .all();

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

export function listPersonsLogic(userId: number): ListPersonsResponse {
  const rows = db
    .select({
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
          ORDER BY COALESCE(julianday(p.taken_at), julianday(p.created_at), 0) DESC, f.id DESC
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
          ORDER BY COALESCE(julianday(p.taken_at), julianday(p.created_at), 0) DESC, f.id DESC
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
          ORDER BY COALESCE(julianday(p.taken_at), julianday(p.created_at), 0) DESC, f.id DESC
          LIMIT 1
        ),
        ''
      )`,
    })
    .from(persons)
    .where(eq(persons.user_id, userId))
    .orderBy(sql`${persons.updated_at} DESC`)
    .all();

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

export function getPersonDetailsLogic(userId: number, personId: number): PersonDetails {
  const person = db
    .select()
    .from(persons)
    .where(and(eq(persons.id, personId), eq(persons.user_id, userId)))
    .get();
  if (!person) throw new Error("Person not found");

  const faceRows = db
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
    .orderBy(sql`COALESCE(julianday(${photos.taken_at}), julianday(${photos.created_at}), 0) DESC`, sql`${faces.id} DESC`)
    .all();

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

export function updatePersonLogic(userId: number, personId: number, name: string): Person & { faceCount: number } {
  if (name.trim().toLowerCase() === "unbenannt") {
    throw new Error("Person kann nicht in 'Unbenannt' umbenannt werden");
  }

  db.update(persons)
    .set({ name, updated_at: sql`datetime('now')` })
    .where(and(eq(persons.id, personId), eq(persons.user_id, userId)))
    .run();

  const updated = db
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
    .get()!;

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

export function mergePersonsLogic(userId: number, req: MergePersonsRequest): { success: boolean } {
  const targetId = req.targetId;
  const sourceIds = req.sourceIds.filter(id => id !== targetId);

  if (sourceIds.length === 0) {
    return { success: true };
  }

  const target = db
    .select()
    .from(persons)
    .where(and(eq(persons.id, targetId), eq(persons.user_id, userId)))
    .get();
  if (!target) throw new Error("Target person not found");
  if (target.name === "Unbenannt") {
    throw new Error("Kann nicht zu einer unbenannten Person zusammenführen");
  }

  // Move all faces from source persons to target person
  db.update(faces)
    .set({ person_id: targetId })
    .where(and(inArray(faces.person_id, sourceIds), eq(faces.user_id, userId)))
    .run();

  // Update target person's cover face if it doesn't have one
  if (!target.cover_face_id) {
    const firstFace = db
      .select({ id: faces.id })
      .from(faces)
      .where(and(eq(faces.person_id, targetId), eq(faces.user_id, userId)))
      .limit(1)
      .get();
    if (firstFace) {
      db.update(persons)
        .set({ cover_face_id: firstFace.id })
        .where(eq(persons.id, targetId))
        .run();
    }
  }

  // Set updated_at for target person
  db.update(persons)
    .set({ updated_at: sql`datetime('now')` })
    .where(eq(persons.id, targetId))
    .run();

  // Delete source persons
  db.delete(persons)
    .where(and(inArray(persons.id, sourceIds), eq(persons.user_id, userId)))
    .run();

  return { success: true };
}

export function assignFaceToPersonLogic(
  userId: number,
  faceId: number,
  personId: number
): { success: boolean } {
  db.update(faces)
    .set({ person_id: personId, ignored: false })
    .where(and(eq(faces.id, faceId), eq(faces.user_id, userId)))
    .run();
  return { success: true };
}

export function ignoreFaceLogic(
  userId: number,
  faceId: number
): { success: boolean } {
  db.update(faces)
    .set({ ignored: true, person_id: null })
    .where(and(eq(faces.id, faceId), eq(faces.user_id, userId)))
    .run();
  return { success: true };
}

export function ignorePersonFacesLogic(
  userId: number,
  personId: number
): { success: boolean } {
  db.update(faces)
    .set({ ignored: true, person_id: null })
    .where(and(eq(faces.person_id, personId), eq(faces.user_id, userId)))
    .run();

  // Also cleanup the person since they no longer have any associated faces
  cleanupOrphanedPersons(userId);

  return { success: true };
}

export function getPhotoFacesLogic(
  userId: number,
  photoId: number
): { faces: Face[] } {
  const rows = db
    .select()
    .from(faces)
    .where(and(eq(faces.photo_id, photoId), eq(faces.user_id, userId)))
    .all();

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
  const photo = db.select().from(photos).where(and(eq(photos.id, photoId), eq(photos.user_id, userId))).get();
  if (!photo) throw new Error("Photo not found");

  await indexPhotoFaces(userId, photoId, true);
  return { success: true };
}

export async function reindexAllPhotosLogic(userId: number): Promise<{ count: number }> {
  const allPhotos = db.select({ id: photos.id }).from(photos).where(eq(photos.user_id, userId)).all();

  console.log(`Starting re-index for ${allPhotos.length} photos for user ${userId}`);

  // Process sequentially in background to avoid race conditions
  // (concurrent processing deletes all faces before new ones are created,
  //  breaking person matching)
  (async () => {
    let processed = 0;
    let errors = 0;
    for (const p of allPhotos) {
      try {
        await indexPhotoFaces(userId, p.id, false);
        processed++;
      } catch (err: any) {
        errors++;
        if (err.message && err.message.includes("FACE_MODELS_NOT_LOADED")) {
          console.error(`Skipping reindex for photo ${p.id}: Modelle nicht geladen.`);
        } else {
          console.error(`Error reindexing photo ${p.id}:`, err);
        }
      }
    }
    // Clean up orphaned persons (persons with 0 associated faces)
    cleanupOrphanedPersons(userId);
    console.log(`Re-index complete for user ${userId}: ${processed} processed, ${errors} errors, orphaned persons cleaned up.`);
  })();

  return { count: allPhotos.length };
}

// ---------- Photo Grouping ----------

/**
 * Similarity threshold for suggesting person merges.
 * Lower than auto-match threshold to catch "maybe the same person" cases.
 */
const SUGGESTION_SIMILARITY_THRESHOLD = Math.max(0.25, FACE_SIMILARITY_THRESHOLD - 0.15);

export function getPhotoGroupsLogic(userId: number): PhotoGroupsResponse {
  // 1. Get all persons with face counts
  const personRows = db
    .select({
      id: persons.id,
      user_id: persons.user_id,
      name: persons.name,
      cover_face_id: persons.cover_face_id,
      created_at: persons.created_at,
      updated_at: persons.updated_at,
      faceCount: sql<number>`CAST(COALESCE((SELECT count(*) FROM faces f WHERE f.person_id = persons.id AND f.ignored = 0), 0) AS INTEGER)`,
      cover_filename: sql<string>`COALESCE(
        (SELECT p.filename FROM faces f INNER JOIN photos p ON p.id = f.photo_id
         WHERE f.person_id = persons.id AND f.user_id = persons.user_id AND f.ignored = 0
         ORDER BY COALESCE(julianday(p.taken_at), julianday(p.created_at), 0) DESC, f.id DESC LIMIT 1), '')`,
      cover_bbox: sql<string>`COALESCE(
        (SELECT f.bbox FROM faces f INNER JOIN photos p ON p.id = f.photo_id
         WHERE f.person_id = persons.id AND f.user_id = persons.user_id AND f.ignored = 0
         ORDER BY COALESCE(julianday(p.taken_at), julianday(p.created_at), 0) DESC, f.id DESC LIMIT 1), '')`,
    })
    .from(persons)
    .where(eq(persons.user_id, userId))
    .all()
    .filter(r => r.faceCount > 0);

  // 2. Load faces with photos for each person (top 6 per person for preview)
  const groups: PhotoGroup[] = personRows
    .sort((a, b) => b.faceCount - a.faceCount)
    .map(r => {
      const faceRows = db
        .select({
          faceId: faces.id,
          faceUserId: faces.user_id,
          photoId: faces.photo_id,
          bbox: faces.bbox,
          personId: faces.person_id,
          quality: faces.quality,
          ignored: faces.ignored,
          faceCreatedAt: faces.created_at,
          filename: photos.filename,
          originalName: photos.original_name,
          mimeType: photos.mime_type,
          size: photos.size,
          hash: photos.hash,
          takenAt: photos.taken_at,
          photoCreatedAt: photos.created_at,
          photoUserId: photos.user_id,
        })
        .from(faces)
        .innerJoin(photos, eq(faces.photo_id, photos.id))
        .where(and(eq(faces.person_id, r.id), eq(faces.user_id, userId), eq(faces.ignored, false)))
        .orderBy(sql`COALESCE(julianday(${photos.taken_at}), julianday(${photos.created_at}), 0) DESC`)
        .limit(6)
        .all();

      return {
        person: {
          id: r.id,
          user_id: r.user_id,
          name: r.name,
          cover_face_id: r.cover_face_id ?? undefined,
          cover_filename: r.cover_filename || undefined,
          cover_bbox: r.cover_bbox ? JSON.parse(r.cover_bbox) : undefined,
          created_at: r.created_at ?? "",
          updated_at: r.updated_at ?? "",
          faceCount: r.faceCount,
        },
        photos: faceRows.map(fr => ({
          photo: {
            id: fr.photoId,
            user_id: fr.photoUserId,
            filename: fr.filename,
            original_name: fr.originalName,
            mime_type: fr.mimeType,
            size: fr.size,
            hash: fr.hash ?? undefined,
            taken_at: fr.takenAt ?? undefined,
            created_at: fr.photoCreatedAt ?? "",
          },
          face: {
            id: fr.faceId,
            user_id: fr.faceUserId,
            photo_id: fr.photoId,
            bbox: JSON.parse(fr.bbox),
            embedding: [], // Don't send embeddings to frontend
            person_id: fr.personId ?? undefined,
            quality: fr.quality ?? undefined,
            ignored: !!fr.ignored,
            created_at: fr.faceCreatedAt ?? "",
          },
        })),
      };
    });

  // 3. Compute similarity suggestions between persons
  const allFaces = db
    .select({ person_id: faces.person_id, embedding: faces.embedding })
    .from(faces)
    .where(and(eq(faces.user_id, userId), sql`${faces.person_id} IS NOT NULL`, eq(faces.ignored, false)))
    .all();

  const personEmbeddings: Record<number, number[][]> = {};
  for (const f of allFaces) {
    if (!f.person_id) continue;
    if (!personEmbeddings[f.person_id]) personEmbeddings[f.person_id] = [];
    personEmbeddings[f.person_id].push(JSON.parse(f.embedding as string));
  }

  const centroids: Record<number, number[]> = {};
  for (const [pid, embs] of Object.entries(personEmbeddings)) {
    centroids[parseInt(pid)] = computeCentroid(embs);
  }

  const suggestions: SimilarPersonPair[] = [];
  const personList = personRows.filter(p => centroids[p.id]);

  for (let i = 0; i < personList.length; i++) {
    for (let j = i + 1; j < personList.length; j++) {
      const p1 = personList[i];
      const p2 = personList[j];
      const sim = cosineSimilarity(centroids[p1.id], centroids[p2.id]);

      if (sim >= SUGGESTION_SIMILARITY_THRESHOLD && sim < FACE_SIMILARITY_THRESHOLD) {
        suggestions.push({
          person1: {
            id: p1.id, user_id: p1.user_id, name: p1.name,
            cover_face_id: p1.cover_face_id ?? undefined,
            cover_filename: p1.cover_filename || undefined,
            cover_bbox: p1.cover_bbox ? JSON.parse(p1.cover_bbox) : undefined,
            created_at: p1.created_at ?? "", updated_at: p1.updated_at ?? "",
            faceCount: p1.faceCount,
          },
          person2: {
            id: p2.id, user_id: p2.user_id, name: p2.name,
            cover_face_id: p2.cover_face_id ?? undefined,
            cover_filename: p2.cover_filename || undefined,
            cover_bbox: p2.cover_bbox ? JSON.parse(p2.cover_bbox) : undefined,
            created_at: p2.created_at ?? "", updated_at: p2.updated_at ?? "",
            faceCount: p2.faceCount,
          },
          similarity: Math.round(sim * 100) / 100,
        });
      }
    }
  }

  suggestions.sort((a, b) => b.similarity - a.similarity);

  return { groups, suggestions };
}

/**
 * Remove persons that have no associated faces (orphaned after re-indexing).
 */
function cleanupOrphanedPersons(userId: number): void {
  const deleted = db.delete(persons)
    .where(
      and(
        eq(persons.user_id, userId),
        sql`NOT EXISTS (SELECT 1 FROM faces WHERE faces.person_id = persons.id)`
      )
    )
    .run();
  console.log(`Cleaned up ${deleted.changes} orphaned persons for user ${userId}`);
}
