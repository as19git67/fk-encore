import fs from "fs";
import path from "path";
import crypto from "crypto";
import exifr from "exifr";
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
  Face,
  ListPersonsResponse,
  PersonDetails,
  MergePersonsRequest,
} from "../db/types";
import * as faceapi from "@vladmandic/face-api";
import { Canvas, Image, loadImage } from "canvas";
import heicConvert from "heic-convert";

// Patch face-api for Node.js
// @ts-ignore
faceapi.env.monkeyPatch({ Canvas, Image });

// Fix for newer Node.js versions (e.g. v24) where tfjs-node relies on removed util functions
import * as util from "util";
if (!(util as any).isNullOrUndefined) {
    try {
        Object.defineProperty(util, 'isNullOrUndefined', {
            value: (val: any) => val === null || val === undefined,
            writable: true,
            configurable: true
        });
    } catch (e) {
        // Fallback for environments where util is not extensible
    }
}
if (!(util as any).isArray) {
    try {
        Object.defineProperty(util, 'isArray', {
            value: Array.isArray,
            writable: true,
            configurable: true
        });
    } catch (e) {
        // Fallback
    }
}

export const UPLOAD_DIR = path.resolve(process.env.PHOTO_UPLOAD_DIR || "uploads/photos");
export const MODEL_DIR = path.resolve(process.env.FACE_MODEL_DIR || "data/models");
const FACE_THRESHOLD = parseFloat(process.env.FACE_SIMILARITY_THRESHOLD || "0.65");
const ENABLE_LOCAL_FACES = process.env.ENABLE_LOCAL_FACES === "true";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(MODEL_DIR)) {
    fs.mkdirSync(MODEL_DIR, { recursive: true });
}

let modelsLoaded = false;
async function ensureModelsLoaded() {
    if (modelsLoaded) return;
    try {
        await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
        await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
        await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
        modelsLoaded = true;
    } catch (err) {
        console.error("Error loading face models from", MODEL_DIR, ":", err);
        throw new Error("FACE_MODELS_NOT_LOADED: Bitte führen Sie './scripts/download_models.sh' aus, um die KI-Modelle herunterzuladen.");
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
        if (err.message.includes("FACE_MODELS_NOT_LOADED")) {
            console.error("Gesichtserkennung übersprungen: Modelle nicht geladen. Führen Sie ./scripts/download_models.sh aus.");
        } else {
            console.error("Face indexing error:", err);
        }
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
        if (err.message.includes("FACE_MODELS_NOT_LOADED")) {
            console.error("Gesichtserkennung übersprungen: Modelle nicht geladen. Führen Sie ./scripts/download_models.sh aus.");
        } else {
            console.error("Face indexing error:", err);
        }
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
  return { success: true };
}

// ---------- People & Faces ----------

export async function indexPhotoFaces(userId: number, photoId: number): Promise<void> {
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

  await ensureModelsLoaded();

  let imgData: Buffer | string = filePath;

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
      imgData = outputBuffer as Buffer;
    } catch (err) {
      console.error(`Error converting HEIC photo ${photoId}:`, err);
      // Fallback to original path, though it will likely fail in loadImage
    }
  }

  const img = await loadImage(imgData);
  const detections = await faceapi
    .detectAllFaces(img as any)
    .withFaceLandmarks()
    .withFaceDescriptors();

  console.log(`Detected ${detections.length} faces in photo ${photoId}`);

  // Remove existing faces for this photo
  db.delete(faces).where(eq(faces.photo_id, photoId)).run();

  for (const det of detections) {
    const bbox = {
      x: det.detection.relativeBox.x,
      y: det.detection.relativeBox.y,
      width: det.detection.relativeBox.width,
      height: det.detection.relativeBox.height,
    };
    const embedding = Array.from(det.descriptor);

    // Find best matching person (using a slightly higher threshold for initial matching)
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
        quality: Math.round(det.detection.score * 100),
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
            // Check if the current cover_face_id still exists in the faces table
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
        // Still update updated_at to show activity
        db.update(persons).set({ 
            updated_at: sql`datetime('now')`
        }).where(eq(persons.id, personId)).run();
    }
  }
}

async function findBestPersonMatch(
  userId: number,
  embedding: number[]
): Promise<{ personId: number; score: number } | null> {
  const allFaces = db
    .select({
      person_id: faces.person_id,
      embedding: faces.embedding,
    })
    .from(faces)
    .where(and(eq(faces.user_id, userId), sql`${faces.person_id} IS NOT NULL`))
    .all();

  // Group embeddings by person for more robust matching
  const personEmbeddings: Record<number, number[][]> = {};
  for (const face of allFaces) {
    if (!personEmbeddings[face.person_id!]) {
      personEmbeddings[face.person_id!] = [];
    }
    personEmbeddings[face.person_id!].push(JSON.parse(face.embedding as string) as number[]);
  }

  let bestMatch: { personId: number; score: number } | null = null;

  for (const [personIdStr, embeddings] of Object.entries(personEmbeddings)) {
    const personId = parseInt(personIdStr);
    
    // Check similarity against each face of this person
    // and take the maximum similarity
    let maxPersonScore = 0;
    for (const faceEmbedding of embeddings) {
      const score = cosineSimilarity(embedding, faceEmbedding);
      if (score > maxPersonScore) {
        maxPersonScore = score;
      }
    }

    if (maxPersonScore > FACE_THRESHOLD) {
      if (!bestMatch || maxPersonScore > bestMatch.score) {
        bestMatch = { personId, score: maxPersonScore };
      }
    }
  }

  return bestMatch;
}

function cosineSimilarity(v1: number[], v2: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < v1.length; i++) {
    dotProduct += v1[i] * v2[i];
    normA += v1[i] * v1[i];
    normB += v2[i] * v2[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function listPersonsLogic(userId: number): ListPersonsResponse {
  const rows = db
    .select({
      id: persons.id,
      user_id: persons.user_id,
      name: persons.name,
      cover_face_id: persons.cover_face_id,
      created_at: persons.created_at,
      updated_at: persons.updated_at,
      faceCount: sql<number>`CAST(COALESCE((SELECT count(*) FROM ${faces} f WHERE f.${faces.person_id} = ${persons.id}), 0) AS INTEGER)`,
      cover_filename: sql<string>`COALESCE((SELECT p.${photos.filename} FROM ${photos} p INNER JOIN ${faces} f ON f.${faces.photo_id} = p.${photos.id} WHERE f.${faces.id} = ${persons.cover_face_id} LIMIT 1), '')`,
      cover_bbox: sql<string>`COALESCE((SELECT f.${faces.bbox} FROM ${faces} f WHERE f.${faces.id} = ${persons.cover_face_id} LIMIT 1), '')`,
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
    .select()
    .from(faces)
    .where(and(eq(faces.person_id, personId), eq(faces.user_id, userId)))
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
      created_at: r.created_at ?? "",
    })),
  };
}

export function updatePersonLogic(userId: number, personId: number, name: string): Person & { faceCount: number } {
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
      faceCount: sql<number>`CAST(COALESCE((SELECT count(*) FROM ${faces} f WHERE f.${faces.person_id} = ${persons.id}), 0) AS INTEGER)`,
      cover_filename: sql<string>`COALESCE((SELECT p.${photos.filename} FROM ${photos} p INNER JOIN ${faces} f ON f.${faces.photo_id} = p.${photos.id} WHERE f.${faces.id} = ${persons.cover_face_id} LIMIT 1), '')`,
      cover_bbox: sql<string>`COALESCE((SELECT f.${faces.bbox} FROM ${faces} f WHERE f.${faces.id} = ${persons.cover_face_id} LIMIT 1), '')`,
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
  const target = db
    .select()
    .from(persons)
    .where(and(eq(persons.id, req.targetId), eq(persons.user_id, userId)))
    .get();
  if (!target) throw new Error("Target person not found");

  for (const sourceId of req.sourceIds) {
    if (sourceId === req.targetId) continue;
    db.update(faces)
      .set({ person_id: req.targetId })
      .where(and(eq(faces.person_id, sourceId), eq(faces.user_id, userId)))
      .run();
    db.delete(persons).where(and(eq(persons.id, sourceId), eq(persons.user_id, userId))).run();
  }

  return { success: true };
}

export function assignFaceToPersonLogic(
  userId: number,
  faceId: number,
  personId: number
): { success: boolean } {
  db.update(faces)
    .set({ person_id: personId })
    .where(and(eq(faces.id, faceId), eq(faces.user_id, userId)))
    .run();
  return { success: true };
}

export async function reindexAllPhotosLogic(userId: number): Promise<{ count: number }> {
  const allPhotos = db.select({ id: photos.id }).from(photos).where(eq(photos.user_id, userId)).all();

  console.log(`Starting re-index for ${allPhotos.length} photos for user ${userId}`);

  // Process in background
  for (const p of allPhotos) {
    indexPhotoFaces(userId, p.id).catch((err) => {
      if (err.message && err.message.includes("FACE_MODELS_NOT_LOADED")) {
          console.error(`Skipping reindex for photo ${p.id}: Modelle nicht geladen.`);
      } else {
          console.error(`Error reindexing photo ${p.id}:`, err);
      }
    });
  }

  return { count: allPhotos.length };
}
