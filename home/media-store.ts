/**
 * Photo files of the house handbook (documentation/plans/haus-anlagen.md,
 * stage 2) — rows in `home_media` and the files they name, without access
 * checks. The checks live in `media.service.ts`; the system service uses the
 * removal helpers here when a guide, item, note or system goes.
 *
 * The files sit on a volume directory like the meter photos (no Encore
 * bucket: the self-hosted stack has no object storage). Each upload is
 * stored twice as JPEG — `<key>.jpg` (long side at most 2048 px) and
 * `<key>.small.jpg` (480 px) — turned upright from the EXIF orientation and
 * written without any metadata, so the camera's location never leaves the
 * phone.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import sharp, { type OutputInfo } from "sharp";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { homeMedia, type HomeMediaTargetKind } from "../db/schema";

export const HOME_MEDIA_TARGET_KINDS: readonly HomeMediaTargetKind[] = ["system", "guide", "item", "note"];

/** Long side of the stored photo and of its small copy. */
export const FULL_SIZE = 2048;
export const SMALL_SIZE = 480;
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export function homeMediaDir(): string {
  return path.resolve(process.env.HOME_MEDIA_DIR || "uploads/home");
}

export type MediaSize = "full" | "small";

/** The file of `objectKey` in `size`, always below the media directory. */
export function mediaFilePath(objectKey: string, size: MediaSize): string {
  const root = homeMediaDir();
  const file = path.resolve(root, `${objectKey}${size === "small" ? ".small" : ""}.jpg`);
  if (!file.startsWith(root + path.sep)) throw new Error("media path outside the media directory");
  return file;
}

export class UnsupportedImageError extends Error {
  constructor() {
    super("unsupported image");
  }
}

export interface ProcessedImage {
  full: Buffer;
  small: Buffer;
  width: number;
  height: number;
}

/** Upright, shrunk JPEGs without metadata (EXIF, GPS, XMP, ICC dropped). */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  let full: { data: Buffer; info: OutputInfo };
  try {
    full = await sharp(input, { failOn: "error" })
      .rotate()
      .resize(FULL_SIZE, FULL_SIZE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new UnsupportedImageError();
  }
  const small = await sharp(full.data)
    .resize(SMALL_SIZE, SMALL_SIZE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
  return { full: full.data, small, width: full.info.width, height: full.info.height };
}

export interface StoreInput {
  systemId: number;
  targetKind: HomeMediaTargetKind;
  targetId: number;
  caption: string | null;
  uploadedBy: number;
  image: ProcessedImage;
}

export type MediaRow = typeof homeMedia.$inferSelect;

export interface HomeMedia {
  id: number;
  targetKind: HomeMediaTargetKind;
  targetId: number;
  caption: string | null;
  width: number;
  height: number;
  createdAt: string;
}

export function toHomeMedia(row: MediaRow): HomeMedia {
  return {
    id: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    caption: row.caption,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

/** Every photo of a system, in upload order. */
export async function listSystemMedia(systemId: number): Promise<HomeMedia[]> {
  const rows = await dbAll<MediaRow>(
    db.select().from(homeMedia).where(eq(homeMedia.system_id, systemId)).orderBy(asc(homeMedia.id)),
  );
  return rows.map(toHomeMedia);
}


/** Write both files, then the row; a failed insert takes the files back. */
export async function storeMedia(input: StoreInput): Promise<MediaRow> {
  const objectKey = `${input.systemId}/${Date.now()}-${randomBytes(6).toString("hex")}`;
  const fullPath = mediaFilePath(objectKey, "full");
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, input.image.full);
  await fs.writeFile(mediaFilePath(objectKey, "small"), input.image.small);
  try {
    const [row] = await db
      .insert(homeMedia)
      .values({
        system_id: input.systemId,
        target_kind: input.targetKind,
        target_id: input.targetId,
        object_key: objectKey,
        caption: input.caption,
        width: input.image.width,
        height: input.image.height,
        uploaded_by: input.uploadedBy,
      })
      .returning();
    return row;
  } catch (err) {
    await removeFiles([objectKey]);
    throw err;
  }
}

/** Remove the files of these keys; a file that is already gone is fine. */
export async function removeFiles(objectKeys: string[]): Promise<void> {
  for (const key of objectKeys) {
    for (const size of ["full", "small"] as const) {
      await fs.rm(mediaFilePath(key, size), { force: true });
    }
  }
}

async function deleteRows(where: SQL): Promise<void> {
  const rows = await dbAll<{ object_key: string }>(
    db.delete(homeMedia).where(where).returning({ object_key: homeMedia.object_key }),
  );
  await removeFiles(rows.map((r) => r.object_key));
}

/** The photos of one guide, item or note, with their files. */
export async function removeMediaOfTarget(kind: HomeMediaTargetKind, targetId: number): Promise<void> {
  await deleteRows(and(eq(homeMedia.target_kind, kind), eq(homeMedia.target_id, targetId))!);
}

/** Every photo of a system, with its files — before the system row goes. */
export async function removeMediaOfSystem(systemId: number): Promise<void> {
  await deleteRows(eq(homeMedia.system_id, systemId));
}

export interface SweepResult {
  rows: number;
  files: number;
}

/** A file this young may belong to an upload whose row is not written yet. */
const SWEEP_FILE_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * The nightly clean-up: rows whose guide, item or note no longer exists (a
 * delete that failed half-way), then files that no row names.
 */
export async function sweepHomeMedia(now: Date = new Date()): Promise<SweepResult> {
  const orphanRows = await dbAll<{ id: number; object_key: string }>(
    db
      .select({ id: homeMedia.id, object_key: homeMedia.object_key })
      .from(homeMedia)
      .where(
        sql`(${homeMedia.target_kind} = 'guide' AND NOT EXISTS (
               SELECT 1 FROM home_system_guides g WHERE g.id = ${homeMedia.target_id} AND g.system_id = ${homeMedia.system_id}))
         OR (${homeMedia.target_kind} = 'item' AND NOT EXISTS (
               SELECT 1 FROM home_system_items i WHERE i.id = ${homeMedia.target_id} AND i.system_id = ${homeMedia.system_id}))
         OR (${homeMedia.target_kind} = 'note' AND NOT EXISTS (
               SELECT 1 FROM home_system_notes n WHERE n.id = ${homeMedia.target_id} AND n.system_id = ${homeMedia.system_id}))`,
      ),
  );
  if (orphanRows.length > 0) {
    await db.delete(homeMedia).where(inArray(homeMedia.id, orphanRows.map((r) => r.id)));
    await removeFiles(orphanRows.map((r) => r.object_key));
  }

  const root = homeMediaDir();
  let files = 0;
  let systemDirs: string[];
  try {
    systemDirs = await fs.readdir(root);
  } catch {
    return { rows: orphanRows.length, files };
  }
  const known = new Set(
    (await dbAll<{ object_key: string }>(db.select({ object_key: homeMedia.object_key }).from(homeMedia)))
      .map((r) => r.object_key),
  );
  for (const dir of systemDirs) {
    const dirPath = path.join(root, dir);
    let entries: string[];
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      continue; // not a directory
    }
    for (const name of entries) {
      const key = `${dir}/${name.replace(/(\.small)?\.jpg$/, "")}`;
      if (known.has(key)) continue;
      const file = path.join(dirPath, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile() || now.getTime() - stat.mtimeMs < SWEEP_FILE_MIN_AGE_MS) continue;
      await fs.rm(file, { force: true });
      files += 1;
    }
    if ((await fs.readdir(dirPath).catch(() => ["keep"])).length === 0) {
      await fs.rmdir(dirPath).catch(() => undefined);
    }
  }
  return { rows: orphanRows.length, files };
}

