/**
 * Photos enclosed with a letter ("hier die Fotos vom Schaden"): each one
 * becomes a page after the letter, under its title (plan ki-assistent.md,
 * stage 7). Only photos the user may see are read — the same rule the
 * gallery applies (`accessiblePhotoCondition`) — and only users who may use
 * photos at all enclose any.
 */

import fs from "node:fs";
import { and, inArray } from "drizzle-orm";
import sharp from "sharp";
import db from "../db/database";
import { photos } from "../db/schema";
import { accessiblePhotoCondition } from "../photo/photo-file-access";
import { getPhotoDiskPath } from "../photo/photo.service";
import type { LetterPhoto } from "./letter-pdf";
import type { LetterAttachment } from "./proposals";

export const PHOTO_PERMISSIONS = ["module.photos", "photos.view"];
export const MAX_LETTER_PHOTOS = 12;
/** Long edge of a photo page: sharp enough for A4 print at about 200 dpi, small enough to mail. */
const PAGE_EDGE = 2000;

export function mayEnclosePhotos(permissions: string[]): boolean {
  return PHOTO_PERMISSIONS.every((p) => permissions.includes(p));
}

interface PhotoRow {
  id: number;
  filename: string;
  external_path: string | null;
  original_name: string | null;
  taken_at: string | null;
}

/** "Foto vom 12.08.2026" when the date is known, otherwise the file name. */
export function photoTitle(row: { id: number; original_name?: string | null; taken_at?: string | null }): string {
  const day = row.taken_at?.slice(0, 10);
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const [y, m, d] = day.split("-");
    return `Foto vom ${d}.${m}.${y}`;
  }
  return row.original_name?.trim() || `Foto ${row.id}`;
}

async function rowsOf(userId: number, ids: number[]): Promise<PhotoRow[]> {
  if (!ids.length) return [];
  const found = await db
    .select({
      id: photos.id,
      filename: photos.filename,
      external_path: photos.external_path,
      original_name: photos.original_name,
      taken_at: photos.taken_at,
    })
    .from(photos)
    .where(and(inArray(photos.id, ids), accessiblePhotoCondition(userId)));
  const byId = new Map(found.map((r) => [Number(r.id), { ...r, id: Number(r.id), taken_at: r.taken_at ? String(r.taken_at) : null }]));
  // In the order asked for; a photo the user cannot see is left out.
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** The enclosed photos' titles, in the order given; ones the user cannot see are left out. */
export async function letterPhotoTitles(userId: number, ids: number[]): Promise<LetterAttachment[]> {
  const rows = await rowsOf(userId, ids.slice(0, MAX_LETTER_PHOTOS));
  return rows.map((r) => ({ id: r.id, title: photoTitle(r) }));
}

/**
 * The pages to append: each photo upright, scaled to fit, as a JPEG. A file
 * that is missing or cannot be read is left out and named in `missing`, so
 * the letter still goes out and the card can say what is not in it.
 */
export async function letterPhotoPages(
  userId: number,
  enclosed: LetterAttachment[],
): Promise<{ pages: LetterPhoto[]; missing: string[] }> {
  const rows = new Map((await rowsOf(userId, enclosed.map((p) => p.id))).map((r) => [r.id, r]));
  const pages: LetterPhoto[] = [];
  const missing: string[] = [];
  for (const p of enclosed) {
    const row = rows.get(p.id);
    if (!row) continue;
    const source = getPhotoDiskPath(row);
    try {
      await fs.promises.access(source, fs.constants.R_OK);
      const jpeg = await sharp(source, { failOn: "none" })
        .rotate()
        .resize({ width: PAGE_EDGE, height: PAGE_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      pages.push({ title: p.title, jpeg });
    } catch {
      missing.push(p.title);
    }
  }
  return { pages, missing };
}
