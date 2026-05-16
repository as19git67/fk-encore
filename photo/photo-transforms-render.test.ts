// Tests for the Phase 3 server-side render pipeline.
// - renderPhotoWithRecipe: pure function, exercised against synthetic images.
// - renderSuggestedAndCache: DB + cache integration.

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import db from "../db/database";
import {
  photos,
  photoTransformSuggestions,
  users,
  type PhotoTransformSuggestionsPayload,
} from "../db/schema";
import { dbInsertReturning } from "../db/adapter";
import { createUserLogic } from "../user/user.service";
import {
  computeAutoLevelsForPhoto,
  recipeCacheKey,
  recipeFromSuggestion,
  renderPhotoWithRecipe,
  renderSuggestedAndCache,
  renderUserAndCache,
  resolvePhotoFilename,
} from "./photo-transforms-render.service";
import { photoTransforms } from "../db/schema";

const TMP_DIR = "/tmp/fk-encore-render-test";

async function makeTestImage(
  filename: string,
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number } = { r: 60, g: 60, b: 60 },
): Promise<string> {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, filename);
  await sharp({
    create: { width, height, channels: 3, background: rgb },
  })
    .jpeg()
    .toFile(filePath);
  return filePath;
}

async function meanLuma(buffer: Buffer): Promise<number> {
  const stats = await sharp(buffer).stats();
  const rgb = stats.channels.slice(0, 3);
  return rgb.reduce((s, c) => s + c.mean, 0) / rgb.length / 255;
}

describe("renderPhotoWithRecipe — pure pipeline", () => {
  it("returns the original (decoded as JPEG) when no transforms are set", async () => {
    const p = await makeTestImage(`flat-${Date.now()}.jpg`, 200, 100);
    const out = await renderPhotoWithRecipe(p, {});
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
    expect(meta.format).toBe("jpeg");
  });

  it("crops in pixel space based on normalised coords", async () => {
    const p = await makeTestImage(`crop-${Date.now()}.jpg`, 400, 300);
    const out = await renderPhotoWithRecipe(p, {
      crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200); // 0.5 × 400
    expect(meta.height).toBe(150); // 0.5 × 300
  });

  it("brightens at positive exposure", async () => {
    const p = await makeTestImage(`exp-${Date.now()}.jpg`, 100, 100, {
      r: 80,
      g: 80,
      b: 80,
    });
    const baseline = await renderPhotoWithRecipe(p, {});
    const brighter = await renderPhotoWithRecipe(p, { exposure: 1 });
    expect(await meanLuma(brighter)).toBeGreaterThan(await meanLuma(baseline));
  });

  it("darkens at negative exposure", async () => {
    const p = await makeTestImage(`exp2-${Date.now()}.jpg`, 100, 100, {
      r: 180,
      g: 180,
      b: 180,
    });
    const darker = await renderPhotoWithRecipe(p, { exposure: -1 });
    const baseline = await renderPhotoWithRecipe(p, {});
    expect(await meanLuma(darker)).toBeLessThan(await meanLuma(baseline));
  });

  it("resizes to the requested width while preserving aspect", async () => {
    const p = await makeTestImage(`rs-${Date.now()}.jpg`, 800, 400);
    const out = await renderPhotoWithRecipe(p, {}, 200);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100); // 800:400 = 2:1 → 200:100
  });

  it("swaps dimensions on 90° rotation", async () => {
    const p = await makeTestImage(`rot-${Date.now()}.jpg`, 200, 100);
    const out = await renderPhotoWithRecipe(p, { rotation: 90 });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
  });

  it("combines crop + resize + exposure in one pipeline", async () => {
    const p = await makeTestImage(`combo-${Date.now()}.jpg`, 400, 400, {
      r: 50,
      g: 50,
      b: 50,
    });
    const out = await renderPhotoWithRecipe(
      p,
      { crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, exposure: 1.5 },
      100,
    );
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
    expect(await meanLuma(out)).toBeGreaterThan(50 / 255);
  });
});

describe("recipeFromSuggestion", () => {
  const payload: PhotoTransformSuggestionsPayload = {
    crops: {
      "1:1": { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      "16:9": { x: 0, y: 0.2, w: 1, h: 0.5 },
    },
    exposure: 0.4,
    contrast: 0.1,
    gamma: 1,
  };

  it("returns the crop and the recipe's exposure for a present ratio", () => {
    const r = recipeFromSuggestion(payload, "1:1");
    expect(r).not.toBeNull();
    expect(r!.crop).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(r!.exposure).toBeCloseTo(0.4, 5);
    expect(r!.contrast).toBeCloseTo(0.1, 5);
  });

  it("returns null for a missing ratio", () => {
    expect(recipeFromSuggestion(payload, "4:5")).toBeNull();
  });
});

describe("recipeCacheKey", () => {
  it("is stable for identical recipes", () => {
    const k1 = recipeCacheKey({ exposure: 0.5, contrast: 0.1, gamma: 1 });
    const k2 = recipeCacheKey({ exposure: 0.5, contrast: 0.1, gamma: 1 });
    expect(k1).toBe(k2);
  });
  it("changes when any field changes", () => {
    const k1 = recipeCacheKey({ exposure: 0.5 });
    const k2 = recipeCacheKey({ exposure: 0.6 });
    expect(k1).not.toBe(k2);
  });
  it("treats absent and zero-default fields as equivalent", () => {
    const k1 = recipeCacheKey({});
    const k2 = recipeCacheKey({ exposure: 0, contrast: 0, gamma: 1, rotation: 0 });
    expect(k1).toBe(k2);
  });
});

describe("renderSuggestedAndCache", () => {
  let userId: number;
  let photoId: number;
  let filePath: string;

  beforeEach(async () => {
    await db.delete(photoTransformSuggestions);
    await db.delete(photos);
    await db.delete(users);

    const u = await createUserLogic({
      email: `r-${Date.now()}@example.com`,
      name: "R",
      password: "pw",
    });
    userId = u.id;

    filePath = await makeTestImage(`render-${Date.now()}.jpg`, 400, 200, {
      r: 100,
      g: 100,
      b: 100,
    });

    const created = await dbInsertReturning<{ id: number }>(
      db
        .insert(photos)
        .values({
          user_id: userId,
          filename: filePath,
          original_name: "render.jpg",
          mime_type: "image/jpeg",
          size: 1024,
          width: 400,
          height: 200,
          external_path: filePath,
          hash: `hash-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        })
        .returning({ id: photos.id }),
    );
    photoId = created!.id;

    const payload: PhotoTransformSuggestionsPayload = {
      crops: { "1:1": { x: 0.25, y: 0, w: 0.5, h: 1 } },
      exposure: 0.5,
      contrast: 0,
      gamma: 1,
    };
    await db
      .insert(photoTransformSuggestions)
      .values({ photo_id: photoId, payload, model_version: "v1" });
  });

  it("renders a suggestion + persists the cache file (cache miss → hit)", async () => {
    const r1 = await renderSuggestedAndCache(photoId, "1:1", 100);
    expect(r1).not.toBeNull();
    expect(r1!.cacheHit).toBe(false);
    const meta1 = await sharp(r1!.buffer).metadata();
    expect(meta1.width).toBe(100);
    expect(meta1.height).toBe(100); // 1:1

    // Wait a moment for the fire-and-forget cache write to land.
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(r1!.cachePath)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(r1!.cachePath)).toBe(true);

    const r2 = await renderSuggestedAndCache(photoId, "1:1", 100);
    expect(r2).not.toBeNull();
    expect(r2!.cacheHit).toBe(true);
    expect(r2!.etag).toBe(r1!.etag);
  });

  it("returns null when the requested ratio isn't in the payload", async () => {
    const r = await renderSuggestedAndCache(photoId, "9:16", 100);
    expect(r).toBeNull();
  });

  it("returns null when no suggestion exists for the photo", async () => {
    await db.delete(photoTransformSuggestions).where(eq(photoTransformSuggestions.photo_id, photoId));
    const r = await renderSuggestedAndCache(photoId, "1:1", 100);
    expect(r).toBeNull();
  });

  it("returns null for an unknown photo id", async () => {
    const r = await renderSuggestedAndCache(999_999, "1:1", 100);
    expect(r).toBeNull();
  });
});

describe("renderUserAndCache", () => {
  let userId: number;
  let photoId: number;

  beforeEach(async () => {
    await db.delete(photoTransforms);
    await db.delete(photoTransformSuggestions);
    await db.delete(photos);
    await db.delete(users);

    const u = await createUserLogic({
      email: `ru-${Date.now()}@example.com`,
      name: "RU",
      password: "pw",
    });
    userId = u.id;
    const filePath = await makeTestImage(`renderuser-${Date.now()}.jpg`, 400, 200, {
      r: 80,
      g: 80,
      b: 80,
    });
    const created = await dbInsertReturning<{ id: number }>(
      db
        .insert(photos)
        .values({
          user_id: userId,
          filename: filePath,
          original_name: "ru.jpg",
          mime_type: "image/jpeg",
          size: 1024,
          width: 400,
          height: 200,
          external_path: filePath,
          hash: `hash-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        })
        .returning({ id: photos.id }),
    );
    photoId = created!.id;
  });

  it("renders the user's recipe and caches the result", async () => {
    await db.insert(photoTransforms).values({
      photo_id: photoId,
      user_id: userId,
      source: "user",
      crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
      rotation: 0,
      exposure: 0.5,
      contrast: 0,
      gamma: 1,
    });

    const r1 = await renderUserAndCache(photoId, userId, 100);
    expect(r1).not.toBeNull();
    expect(r1!.cacheHit).toBe(false);
    const meta = await sharp(r1!.buffer).metadata();
    expect(meta.width).toBe(100);

    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(r1!.cachePath)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const r2 = await renderUserAndCache(photoId, userId, 100);
    expect(r2!.cacheHit).toBe(true);
  });

  it("returns null when no transform exists for (photo, user)", async () => {
    const r = await renderUserAndCache(photoId, userId, 100);
    expect(r).toBeNull();
  });

  it("returns null for an unknown photo id", async () => {
    const r = await renderUserAndCache(999_999, userId, 100);
    expect(r).toBeNull();
  });
});

describe("resolvePhotoFilename", () => {
  it("returns the stored filename", async () => {
    await db.delete(photoTransforms);
    await db.delete(photos);
    await db.delete(users);
    const u = await createUserLogic({
      email: `rf-${Date.now()}@example.com`,
      name: "RF",
      password: "pw",
    });
    const created = await dbInsertReturning<{ id: number }>(
      db
        .insert(photos)
        .values({
          user_id: u.id,
          filename: "2026/2026-05/test.jpg",
          original_name: "t.jpg",
          mime_type: "image/jpeg",
          size: 100,
          width: 10,
          height: 10,
        })
        .returning({ id: photos.id }),
    );
    expect(await resolvePhotoFilename(created!.id)).toBe("2026/2026-05/test.jpg");
  });

  it("returns null for an unknown photo", async () => {
    expect(await resolvePhotoFilename(999_999)).toBeNull();
  });
});

describe("computeAutoLevelsForPhoto", () => {
  let userId: number;
  let photoId: number;

  beforeEach(async () => {
    await db.delete(photoTransforms);
    await db.delete(photos);
    await db.delete(users);
    const u = await createUserLogic({
      email: `al-${Date.now()}@example.com`,
      name: "AL",
      password: "pw",
    });
    userId = u.id;
    const filePath = await makeTestImage(`autolevels-${Date.now()}.jpg`, 400, 200, {
      r: 60,
      g: 60,
      b: 60,
    });
    const created = await dbInsertReturning<{ id: number }>(
      db
        .insert(photos)
        .values({
          user_id: userId,
          filename: filePath,
          original_name: "al.jpg",
          mime_type: "image/jpeg",
          size: 1024,
          width: 400,
          height: 200,
          external_path: filePath,
        })
        .returning({ id: photos.id }),
    );
    photoId = created!.id;
  });

  it("returns a positive exposure for a dark image (full-frame)", async () => {
    const r = await computeAutoLevelsForPhoto(photoId, null);
    expect(r).not.toBeNull();
    expect(r!.exposure).toBeGreaterThan(0);
    expect(r!.gamma).toBe(1);
  });

  it("computes stats over the crop region when one is given", async () => {
    const r = await computeAutoLevelsForPhoto(photoId, {
      x: 0.1,
      y: 0.1,
      w: 0.5,
      h: 0.5,
    });
    expect(r).not.toBeNull();
    expect(r!.exposure).toBeGreaterThan(0);
  });

  it("returns null for an unknown photo", async () => {
    expect(await computeAutoLevelsForPhoto(999_999, null)).toBeNull();
  });

  it("does not throw when photos.width/height disagree with the actual file dimensions", async () => {
    // Regression: previously the function trusted photos.width and
    // photos.height as the basis for converting the normalised crop
    // to pixel coords. For EXIF-rotated photos those DB values are
    // often the pre-rotation dimensions, so .extract() would go
    // out-of-bounds and sharp would throw — bubbling up as a 500.
    // The function now reads dimensions from sharp directly, so a
    // mismatch in the DB columns is harmless.
    const fs = await import("fs");
    const sharpMod = (await import("sharp")).default;
    const filePath = `${TMP_DIR}/wrongdim-${Date.now()}.jpg`;
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    await sharpMod({
      create: { width: 300, height: 200, channels: 3, background: { r: 50, g: 50, b: 50 } },
    })
      .jpeg()
      .toFile(filePath);

    // Insert with DELIBERATELY-WRONG dims to mimic the EXIF-rotation
    // case (file is 300×200; DB claims 200×300).
    const bad = await dbInsertReturning<{ id: number }>(
      db
        .insert(photos)
        .values({
          user_id: userId,
          filename: filePath,
          original_name: "wrongdim.jpg",
          mime_type: "image/jpeg",
          size: 100,
          width: 200,
          height: 300,
          external_path: filePath,
        })
        .returning({ id: photos.id }),
    );

    const r = await computeAutoLevelsForPhoto(bad!.id, {
      x: 0.5,
      y: 0.5,
      w: 0.4,
      h: 0.4,
    });
    expect(r).not.toBeNull();
    expect(r!.gamma).toBe(1);
  });
});
