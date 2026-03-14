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
} from "../db/types";

export const UPLOAD_DIR = path.resolve(process.env.PHOTO_UPLOAD_DIR || "uploads/photos");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
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
    .onConflictDoUpdate({
      target: [albumShares.album_id, albumShares.user_id],
      set: { access_level: req.accessLevel },
    })
    .run();

  return { success: true };
}
