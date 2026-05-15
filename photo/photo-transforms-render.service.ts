// Photo transformations — Phase 3: server-side rendering pipeline.
//
// Renders a photo with a recipe applied. Used for grid-size thumbnails
// and full-resolution exports; the detail view and editor live-preview
// stay client-side and apply the recipe via CSS/SVG filters instead.
//
// The pure renderPhotoWithRecipe() function takes a path + recipe and
// returns a JPEG buffer; renderSuggestedAndCache() adds the DB lookup
// and the filesystem cache layer.

import path from "path";
import crypto from "crypto";
import fs from "fs/promises";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import {
  photoTransforms,
  photoTransformSuggestions,
  photos,
  type PhotoTransformAspectRatio,
  type PhotoTransformCrop,
  type PhotoTransformSuggestionsPayload,
} from "../db/schema";
import { computeAutoExposureFromStats, type BboxNorm } from "./photo-transforms.service";

// Mirror of THUMBNAIL_DIR / UPLOAD_DIR in photo.service. Inlined to avoid a
// circular import — the existing file already imports our suggestion-compute
// service.
const THUMBNAIL_DIR = path.resolve(
  process.env.PHOTO_THUMBNAIL_DIR || "/mnt/data/thumbnails",
);
const UPLOAD_DIR = path.resolve(
  process.env.PHOTO_UPLOAD_DIR || "/mnt/data/photos",
);

function thumbnailShardPath(baseName: string): string {
  const shard = crypto.createHash("md5").update(baseName).digest("hex").slice(0, 2);
  return path.join(THUMBNAIL_DIR, shard);
}

function resolvePhotoDiskPath(p: { filename: string; external_path: string | null }): string {
  return p.external_path ? p.external_path : path.join(UPLOAD_DIR, p.filename);
}

// ----------------- Recipe types -----------------

export interface PhotoTransformRecipe {
  crop?: PhotoTransformCrop | null;
  rotation?: number;           // 0 | 90 | 180 | 270
  exposure?: number;           // EV, e.g. -1.5..+1.5
  contrast?: number;           // -1..+1, pivots around mid-grey
  gamma?: number;              // 1.0..3.0 (sharp's range)
  white_point?: number | null; // 0..1
  black_point?: number | null; // 0..1
}

/**
 * Pick a recipe from a suggestion payload for a specific aspect ratio.
 * Returns null if the ratio isn't present in the payload (e.g. the
 * subject didn't fit at that ratio).
 */
export function recipeFromSuggestion(
  payload: PhotoTransformSuggestionsPayload,
  ratio: PhotoTransformAspectRatio,
): PhotoTransformRecipe | null {
  const crop = payload.crops[ratio];
  if (!crop) return null;
  return {
    crop,
    rotation: 0,
    exposure: payload.exposure,
    contrast: payload.contrast,
    gamma: payload.gamma,
    white_point: payload.white_point ?? null,
    black_point: payload.black_point ?? null,
  };
}

/** Stable hash of a recipe, used in the cache key. Field order is fixed. */
export function recipeCacheKey(recipe: PhotoTransformRecipe): string {
  const canonical = JSON.stringify({
    crop: recipe.crop
      ? {
          x: round6(recipe.crop.x),
          y: round6(recipe.crop.y),
          w: round6(recipe.crop.w),
          h: round6(recipe.crop.h),
        }
      : null,
    rotation: recipe.rotation ?? 0,
    exposure: round6(recipe.exposure ?? 0),
    contrast: round6(recipe.contrast ?? 0),
    gamma: round6(recipe.gamma ?? 1),
    white_point: recipe.white_point ?? null,
    black_point: recipe.black_point ?? null,
  });
  return crypto.createHash("md5").update(canonical).digest("hex").slice(0, 16);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ----------------- Pure render -----------------

/**
 * Apply a recipe to an image and return a JPEG buffer. Order of operations:
 *   1. EXIF-aware auto-rotate (so the recipe's normalised coords match
 *      the display orientation).
 *   2. Extract crop (normalised → pixel).
 *   3. User rotation (0/90/180/270).
 *   4. Exposure + contrast as a single linear() pass.
 *   5. Optional black/white-point linear() pass.
 *   6. Optional gamma (sharp constrains to 1.0..3.0).
 *   7. Optional resize.
 *   8. JPEG encode.
 *
 * No DB / cache access; tests exercise this directly.
 */
export async function renderPhotoWithRecipe(
  originalPath: string,
  recipe: PhotoTransformRecipe,
  targetWidth?: number,
): Promise<Buffer> {
  // Read display-orientation dimensions so the crop math works in the
  // same coordinate frame as the suggestion compute.
  const meta = await sharp(originalPath).rotate().metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;

  // Two-stage pipeline because sharp collapses subsequent .rotate() calls.
  // Stage 1: EXIF-aware auto-rotate + extract crop, emit an intermediate
  // buffer. Stage 2: user rotation + colour ops + resize. The intermediate
  // buffer is small (cropped already) so the extra encode/decode is cheap.
  let stage1 = sharp(originalPath).rotate();
  if (recipe.crop && W > 0 && H > 0) {
    const left = clampInt(Math.round(recipe.crop.x * W), 0, W - 1);
    const top = clampInt(Math.round(recipe.crop.y * H), 0, H - 1);
    const width = clampInt(Math.round(recipe.crop.w * W), 1, W - left);
    const height = clampInt(Math.round(recipe.crop.h * H), 1, H - top);
    stage1 = stage1.extract({ left, top, width, height });
  }
  const intermediate = await stage1.toBuffer();

  let pipeline = sharp(intermediate);
  if (recipe.rotation && recipe.rotation !== 0) {
    pipeline = pipeline.rotate(recipe.rotation);
  }

  // Combined exposure + contrast in one linear() call:
  //   x' = expA * x                  (exposure)
  //   x'' = (1 + c) * x' + (1-(1+c))*128   (contrast, pivot 128)
  //   ⇒ x'' = (expA * (1+c)) * x + (1-(1+c))*128
  const expA = Math.pow(2, recipe.exposure ?? 0);
  const c = recipe.contrast ?? 0;
  const contrastA = 1 + c;
  const a = expA * contrastA;
  const b = (1 - contrastA) * 128;
  if (Math.abs(a - 1) > 1e-3 || Math.abs(b) > 1e-3) {
    pipeline = pipeline.linear(a, b);
  }

  if (recipe.black_point != null || recipe.white_point != null) {
    const bp = (recipe.black_point ?? 0) * 255;
    const wp = (recipe.white_point ?? 1) * 255;
    if (wp - bp > 1) {
      const ablw = 255 / (wp - bp);
      const bblw = -bp * ablw;
      pipeline = pipeline.linear(ablw, bblw);
    }
  }

  if (recipe.gamma && recipe.gamma !== 1) {
    // sharp.gamma() accepts only 1.0..3.0; values <1 would need a custom
    // tone-curve. Clamp and move on — the editor sliders enforce the same
    // range, so user-set recipes never trip this.
    const g = Math.max(1.0, Math.min(3.0, recipe.gamma));
    pipeline = pipeline.gamma(g);
  }

  if (targetWidth && targetWidth > 0) {
    pipeline = pipeline.resize(targetWidth, null, { fit: "inside" });
  }

  return pipeline.jpeg({ quality: 85 }).toBuffer();
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// ----------------- DB lookup + filesystem cache -----------------

export interface SuggestedRenderResult {
  buffer: Buffer;
  cacheHit: boolean;
  cachePath: string;
  etag: string;
}

/**
 * Resolve the suggestion for a photo, pick the crop for `ratio`, render
 * at `targetWidth`, and persist the result under the existing sharded
 * thumbnail tree. Subsequent calls with the same arguments stream the
 * cached file.
 *
 * Returns null when:
 *   - the photo or its suggestion row does not exist,
 *   - the requested ratio isn't present in the payload.
 */
export async function renderSuggestedAndCache(
  photoId: number,
  ratio: PhotoTransformAspectRatio,
  targetWidth: number | null,
): Promise<SuggestedRenderResult | null> {
  const photo = await dbFirst<{
    id: number;
    filename: string;
    hash: string | null;
    external_path: string | null;
  }>(
    db
      .select({
        id: photos.id,
        filename: photos.filename,
        hash: photos.hash,
        external_path: photos.external_path,
      })
      .from(photos)
      .where(eq(photos.id, photoId)),
  );
  if (!photo) return null;

  const suggestion = await dbFirst<{
    payload: PhotoTransformSuggestionsPayload;
    model_version: string;
  }>(
    db
      .select({
        payload: photoTransformSuggestions.payload,
        model_version: photoTransformSuggestions.model_version,
      })
      .from(photoTransformSuggestions)
      .where(eq(photoTransformSuggestions.photo_id, photoId)),
  );
  if (!suggestion) return null;

  const recipe = recipeFromSuggestion(suggestion.payload, ratio);
  if (!recipe) return null;

  const originalPath = resolvePhotoDiskPath(photo);
  const keyParts = [
    photo.hash ?? photo.filename,
    suggestion.model_version,
    ratio,
    targetWidth ?? "full",
    recipeCacheKey(recipe),
  ].join("|");
  const cacheBase = `${photoId}_tx_${crypto
    .createHash("md5")
    .update(keyParts)
    .digest("hex")
    .slice(0, 12)}`;
  const shardPath = thumbnailShardPath(cacheBase);
  const cachePath = path.join(shardPath, `${cacheBase}.jpg`);
  const etag = `"${crypto.createHash("md5").update(keyParts).digest("hex")}"`;

  try {
    const buffer = await fs.readFile(cachePath);
    return { buffer, cacheHit: true, cachePath, etag };
  } catch {
    // cache miss — fall through to render
  }

  const buffer = await renderPhotoWithRecipe(
    originalPath,
    recipe,
    targetWidth ?? undefined,
  );

  // Best-effort cache write; never fail the request on a cache write error.
  fs.mkdir(shardPath, { recursive: true })
    .then(() => fs.writeFile(cachePath, buffer))
    .catch((err) =>
      console.error(`[photo-transforms-render] cache write failed for ${cachePath}:`, err),
    );

  return { buffer, cacheHit: false, cachePath, etag };
}

/**
 * Render a photo with a specific user's stored recipe applied.
 *
 * `auth: false` on the consuming endpoint is intentional and on par with
 * the existing /photos/file/* endpoint: the recipe payload (crop +
 * exposure) is not personal data — the underlying photo is already
 * accessible by filename without auth, and recipe coordinates leak
 * nothing beyond aesthetic preference.
 *
 * Returns null when no transform row exists for (photoId, userId).
 */
export async function renderUserAndCache(
  photoId: number,
  userId: number,
  targetWidth: number | null,
): Promise<SuggestedRenderResult | null> {
  const photo = await dbFirst<{
    id: number;
    filename: string;
    hash: string | null;
    external_path: string | null;
  }>(
    db
      .select({
        id: photos.id,
        filename: photos.filename,
        hash: photos.hash,
        external_path: photos.external_path,
      })
      .from(photos)
      .where(eq(photos.id, photoId)),
  );
  if (!photo) return null;

  const row = await dbFirst<typeof photoTransforms.$inferSelect>(
    db
      .select()
      .from(photoTransforms)
      .where(
        and(
          eq(photoTransforms.photo_id, photoId),
          eq(photoTransforms.user_id, userId),
        ),
      ),
  );
  if (!row) return null;

  const recipe: PhotoTransformRecipe = {
    crop: (row.crop as PhotoTransformCrop | null) ?? null,
    rotation: row.rotation,
    exposure: row.exposure,
    contrast: row.contrast,
    gamma: row.gamma,
    white_point: row.white_point,
    black_point: row.black_point,
  };

  const originalPath = resolvePhotoDiskPath(photo);
  const keyParts = [
    photo.hash ?? photo.filename,
    "user",
    userId,
    targetWidth ?? "full",
    recipeCacheKey(recipe),
    // Bump on schema/version change.
    row.updated_at ?? row.created_at ?? "",
  ].join("|");
  const cacheBase = `${photoId}_u${userId}_${crypto
    .createHash("md5")
    .update(keyParts)
    .digest("hex")
    .slice(0, 12)}`;
  const shardPath = thumbnailShardPath(cacheBase);
  const cachePath = path.join(shardPath, `${cacheBase}.jpg`);
  const etag = `"${crypto.createHash("md5").update(keyParts).digest("hex")}"`;

  try {
    const buffer = await fs.readFile(cachePath);
    return { buffer, cacheHit: true, cachePath, etag };
  } catch {
    // cache miss
  }

  const buffer = await renderPhotoWithRecipe(
    originalPath,
    recipe,
    targetWidth ?? undefined,
  );

  fs.mkdir(shardPath, { recursive: true })
    .then(() => fs.writeFile(cachePath, buffer))
    .catch((err) =>
      console.error(`[photo-transforms-render] user cache write failed for ${cachePath}:`, err),
    );

  return { buffer, cacheHit: false, cachePath, etag };
}

/**
 * Look up the stored filename for a photo. Used by the render endpoint's
 * v=original branch to emit a 302 redirect to /photos/file/<filename>.
 */
export async function resolvePhotoFilename(photoId: number): Promise<string | null> {
  const row = await dbFirst<{ filename: string }>(
    db.select({ filename: photos.filename }).from(photos).where(eq(photos.id, photoId)),
  );
  return row?.filename ?? null;
}

/**
 * Compute an auto-levels recipe for a photo, optionally restricted to a
 * crop. Reads sharp.stats() over the (optionally cropped) image and
 * derives exposure / contrast / gamma so the cropped subject lands near
 * mid-grey with reasonable contrast. Does not persist — the caller (the
 * editor's Auto-Levels button) applies it locally.
 */
export async function computeAutoLevelsForPhoto(
  photoId: number,
  crop: PhotoTransformCrop | null,
): Promise<{ exposure: number; contrast: number; gamma: number } | null> {
  const photo = await dbFirst<{
    filename: string;
    external_path: string | null;
    width: number | null;
    height: number | null;
  }>(
    db
      .select({
        filename: photos.filename,
        external_path: photos.external_path,
        width: photos.width,
        height: photos.height,
      })
      .from(photos)
      .where(eq(photos.id, photoId)),
  );
  if (!photo) return null;

  const originalPath = resolvePhotoDiskPath(photo);
  let img = sharp(originalPath).rotate();

  if (crop && photo.width && photo.height) {
    const W = photo.width;
    const H = photo.height;
    const left = Math.max(0, Math.min(W - 1, Math.round(crop.x * W)));
    const top = Math.max(0, Math.min(H - 1, Math.round(crop.y * H)));
    const width = Math.max(1, Math.min(W - left, Math.round(crop.w * W)));
    const height = Math.max(1, Math.min(H - top, Math.round(crop.h * H)));
    img = img.extract({ left, top, width, height });
  }

  const stats = await img.stats();
  const rgb = stats.channels.slice(0, 3);
  if (rgb.length === 0) return { exposure: 0, contrast: 0, gamma: 1 };
  const meanLuma = rgb.reduce((s, c) => s + c.mean, 0) / rgb.length / 255;
  const meanStdev = rgb.reduce((s, c) => s + c.stdev, 0) / rgb.length / 255;
  return computeAutoExposureFromStats(meanLuma, meanStdev);
}

// Silence unused-import warning when the BboxNorm export isn't used directly
// (re-exported types from the suggestion-compute module stay available for
// callers that want the same shape).
export type { BboxNorm };
