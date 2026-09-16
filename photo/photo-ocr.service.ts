/**
 * Text recognition inside photos (issue #1029).
 *
 * A photo of a whiteboard, a sign, a menu or a business card carries text the
 * library is otherwise blind to. This runs every photo through PaddleOCR in
 * the receipt-ocr-service and keeps what it reads: the lines with their
 * geometry (relative to the image, so they survive any render size) plus the
 * whole text as one searchable string.
 *
 * A photo with no text on it gets a row too, with no blocks. That row is what
 * tells the queue not to look at it again, and what distinguishes "scanned,
 * nothing there" from "not scanned yet" for the backfill.
 */

import fs from "fs";
import path from "path";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { dbExec, dbFirst } from "../db/adapter";
import { photoOcr, photos, type PhotoOcrBlock } from "../db/schema";
import { ENABLE_TEXT_OCR } from "./scan-config";
import { convertHeicToJpeg } from "./heic-convert.service";
import { getPhotoDiskPath, UPLOAD_DIR } from "./photo.service";
import { ocrPhoto, PhotoOcrUnavailableError, type PhotoOcrLine } from "./photo-ocr-client";

export { PhotoOcrUnavailableError };

/**
 * Lines below this confidence are dropped before storage.
 *
 * Scene text detection finds "text" in brickwork and foliage, and what comes
 * back is noise that would pollute search far more than it would ever help.
 * The threshold is deliberately mild — a partly legible sign is still worth
 * keeping — and can be tuned without a migration.
 */
const MIN_LINE_CONFIDENCE = parseFloat(process.env.PHOTO_OCR_MIN_CONFIDENCE ?? "0.5");

/** Photos are scaled to this long edge by the service; stored for later re-runs. */
const PHOTO_OCR_LONG_SIDE = parseInt(process.env.PHOTO_OCR_LONG_SIDE ?? "1600", 10);

function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

/** Keep the confident lines, in reading order, as stored blocks. */
export function toStoredBlocks(lines: PhotoOcrLine[], minConfidence = MIN_LINE_CONFIDENCE): PhotoOcrBlock[] {
  return lines
    .filter((line) => line.text.trim().length > 0 && line.confidence >= minConfidence)
    .map((line) => ({
      text: line.text.trim(),
      confidence: line.confidence,
      polygon: line.polygon,
      left: line.left,
      top: line.top,
      right: line.right,
      bottom: line.bottom,
    }));
}

/** The searchable string for a set of blocks: one line per recognised line. */
export function blocksToFullText(blocks: PhotoOcrBlock[]): string {
  return blocks.map((block) => block.text).join("\n");
}

/** Character-weighted mean confidence, mirroring the service's own metric. */
export function meanConfidence(blocks: PhotoOcrBlock[]): number {
  let chars = 0;
  let total = 0;
  for (const block of blocks) {
    const length = block.text.replace(/\s+/g, "").length;
    chars += length;
    total += block.confidence * length;
  }
  return chars > 0 ? Number((total / chars).toFixed(4)) : 0;
}

/**
 * Recognise the text in one photo and store the result.
 *
 * Throws `PhotoOcrUnavailableError` when the service is down or busy so the
 * worker can requeue without counting an attempt; anything else is a real
 * failure of this photo.
 */
export async function indexPhotoText(photoId: number): Promise<void> {
  if (!ENABLE_TEXT_OCR) return;

  const photo = await dbFirst<typeof photos.$inferSelect>(
    db.select().from(photos).where(eq(photos.id, photoId)),
  );
  if (!photo) return;

  const filePath = getPhotoDiskPath(photo);
  if (!fs.existsSync(filePath)) return;

  // HEIC has to be converted first: the OCR service decodes through OpenCV,
  // which has no HEIC support. Same approach as the quality scan.
  let processingPath = filePath;
  let tempPath: string | null = null;
  const ext = path.extname(photo.filename).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    try {
      const jpegBuffer = await convertHeicToJpeg(filePath);
      tempPath = path.join(UPLOAD_DIR, `temp_ocr_${photoId}_${Date.now()}.jpg`);
      await fs.promises.writeFile(tempPath, jpegBuffer);
      processingPath = tempPath;
    } catch (err) {
      console.error(`[text_ocr] HEIC conversion failed (photo ${photoId}):`, err);
      return;
    }
  }

  try {
    const fileData = await fs.promises.readFile(processingPath);
    const result = await ocrPhoto(fileData, {
      filename: path.basename(processingPath),
      mimeType: mimeTypeFor(processingPath),
      maxLongSide: PHOTO_OCR_LONG_SIDE,
    });

    const blocks = toStoredBlocks(result.lines);
    await storePhotoOcr(photoId, blocks);
  } finally {
    if (tempPath) {
      await fs.promises.unlink(tempPath).catch(() => {});
    }
  }
}

/** Write (or replace) the OCR result for a photo. */
export async function storePhotoOcr(photoId: number, blocks: PhotoOcrBlock[]): Promise<void> {
  const fullText = blocksToFullText(blocks);
  const confidence = meanConfidence(blocks);
  await dbExec(
    db
      .insert(photoOcr)
      .values({
        photo_id: photoId,
        blocks,
        full_text: fullText,
        mean_confidence: confidence,
        scanned_long_side: PHOTO_OCR_LONG_SIDE,
      })
      .onConflictDoUpdate({
        target: photoOcr.photo_id,
        set: {
          blocks,
          full_text: fullText,
          mean_confidence: confidence,
          scanned_long_side: PHOTO_OCR_LONG_SIDE,
          updated_at: sql`NOW()`,
        },
      }),
  );
}

export interface PhotoOcrResult {
  photo_id: number;
  blocks: PhotoOcrBlock[];
  full_text: string;
  mean_confidence: number;
  scanned_at: string;
}

/**
 * The stored text of a photo, for the detail panel.
 *
 * Returns null when the photo has not been scanned yet — which the UI shows
 * differently from a photo that was scanned and simply has no text on it.
 */
export async function getPhotoOcrLogic(photoId: number): Promise<PhotoOcrResult | null> {
  const row = await dbFirst<typeof photoOcr.$inferSelect>(
    db.select().from(photoOcr).where(eq(photoOcr.photo_id, photoId)),
  );
  if (!row) return null;
  return {
    photo_id: row.photo_id,
    blocks: (row.blocks ?? []) as PhotoOcrBlock[],
    full_text: row.full_text ?? "",
    mean_confidence: row.mean_confidence ?? 0,
    scanned_at: row.updated_at,
  };
}
