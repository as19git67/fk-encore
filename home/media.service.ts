/**
 * Photos of the house handbook with their access rules (stage 2 of
 * documentation/plans/haus-anlagen.md). A photo belongs to a system, or to
 * one of its guides, items or notes, and is seen by whoever sees the system.
 * Like guides, items and notes, photos are added, captioned and removed by
 * everybody who sees the system (the endpoints also require `home.manage`).
 */

import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import {
  homeMedia,
  homeSystemGuides,
  homeSystemItems,
  homeSystemNotes,
  type HomeMediaTargetKind,
} from "../db/schema";
import {
  HOME_MEDIA_TARGET_KINDS,
  mediaFilePath,
  processImage,
  removeFiles,
  storeMedia,
  toHomeMedia,
  UnsupportedImageError,
  type HomeMedia,
  type MediaRow,
  type MediaSize,
} from "./media-store";
import { loadVisibleSystem } from "./systems.service";

const MAX_CAPTION = 500;

function normalizeCaption(caption: string | null | undefined): string | null {
  const text = (caption ?? "").trim();
  if (!text) return null;
  if (text.length > MAX_CAPTION) throw APIError.invalidArgument(`caption longer than ${MAX_CAPTION} characters`);
  return text;
}

export function parseTargetKind(value: string | null | undefined): HomeMediaTargetKind {
  if (value && (HOME_MEDIA_TARGET_KINDS as readonly string[]).includes(value)) {
    return value as HomeMediaTargetKind;
  }
  throw APIError.invalidArgument(`target must be one of ${HOME_MEDIA_TARGET_KINDS.join(", ")}`);
}

/** The target must be the system itself or one of its own guides, items or notes. */
async function assertTarget(systemId: number, kind: HomeMediaTargetKind, targetId: number): Promise<void> {
  if (kind === "system") {
    if (targetId !== systemId) throw APIError.invalidArgument("a system photo targets the system itself");
    return;
  }
  const table = { guide: homeSystemGuides, item: homeSystemItems, note: homeSystemNotes }[kind];
  const row = await dbFirst<{ id: number }>(
    db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, targetId), eq(table.system_id, systemId))),
  );
  if (!row) throw APIError.notFound(`${kind} not found`);
}

export interface UploadInput {
  targetKind: HomeMediaTargetKind;
  targetId: number;
  caption?: string | null;
  bytes: Buffer;
}

export async function uploadMedia(userId: number, systemId: number, input: UploadInput): Promise<HomeMedia> {
  await loadVisibleSystem(userId, systemId);
  await assertTarget(systemId, input.targetKind, input.targetId);
  if (input.bytes.length === 0) throw APIError.invalidArgument("empty file");
  let image;
  try {
    image = await processImage(input.bytes);
  } catch (err) {
    if (err instanceof UnsupportedImageError) {
      throw APIError.invalidArgument("the file is not an image the app can read (JPEG, PNG, WebP, GIF, TIFF)");
    }
    throw err;
  }
  const row = await storeMedia({
    systemId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    caption: normalizeCaption(input.caption),
    uploadedBy: userId,
    image,
  });
  return toHomeMedia(row);
}

/** A photo whose system the caller sees, else `not_found`. */
async function loadVisibleMedia(userId: number, mediaId: number): Promise<MediaRow> {
  const row = await dbFirst<MediaRow>(db.select().from(homeMedia).where(eq(homeMedia.id, mediaId)));
  if (!row) throw APIError.notFound("photo not found");
  try {
    await loadVisibleSystem(userId, row.system_id);
  } catch {
    throw APIError.notFound("photo not found");
  }
  return row;
}

export async function mediaFile(
  userId: number,
  mediaId: number,
  size: MediaSize,
): Promise<{ path: string; bytes: number }> {
  const row = await loadVisibleMedia(userId, mediaId);
  const file = mediaFilePath(row.object_key, size);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) throw APIError.notFound("photo file missing");
  return { path: file, bytes: stat.size };
}

export async function updateMediaCaption(
  userId: number,
  mediaId: number,
  caption: string | null,
): Promise<HomeMedia> {
  const row = await loadVisibleMedia(userId, mediaId);
  const [updated] = await db
    .update(homeMedia)
    .set({ caption: normalizeCaption(caption) })
    .where(eq(homeMedia.id, row.id))
    .returning();
  return toHomeMedia(updated);
}

export async function deleteMedia(userId: number, mediaId: number): Promise<void> {
  const row = await loadVisibleMedia(userId, mediaId);
  await db.delete(homeMedia).where(eq(homeMedia.id, row.id));
  await removeFiles([row.object_key]);
}
