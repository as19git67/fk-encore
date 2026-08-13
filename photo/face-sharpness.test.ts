import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import { faces, photos, users } from "../db/schema";
import { createUserLogic } from "../user/user.service";
import {
  FACE_SAMPLE_SIZE,
  LAPLACIAN_FULL_SCALE,
  faceCropRect,
  laplacianVariance,
  loadGrayImage,
  measureFaceSharpness,
  normalizeSharpness,
} from "./face-sharpness";
import { backfillFaceSharpnessLogic } from "./photo.service";

describe("faceCropRect", () => {
  it("converts a normalised bbox into a pixel rect", () => {
    expect(faceCropRect({ x: 0.25, y: 0.5, width: 0.25, height: 0.25 }, 400, 400)).toEqual({
      x: 100,
      y: 200,
      width: 100,
      height: 100,
    });
  });

  it("clamps a bbox that runs past the image edge", () => {
    const rect = faceCropRect({ x: 0.8, y: 0.8, width: 0.5, height: 0.5 }, 100, 100);
    expect(rect).toEqual({ x: 80, y: 80, width: 20, height: 20 });
  });

  it("rejects crops below the measurable minimum", () => {
    // 0.05 × 100 px = 5 px, under MIN_FACE_PIXELS.
    expect(faceCropRect({ x: 0.1, y: 0.1, width: 0.05, height: 0.05 }, 100, 100)).toBeNull();
  });

  it("rejects degenerate and out-of-space boxes", () => {
    expect(faceCropRect(null, 100, 100)).toBeNull();
    expect(faceCropRect({ x: 0, y: 0, width: 0, height: 0.5 }, 100, 100)).toBeNull();
    // Pixel coordinates handed in where normalised ones are expected.
    expect(faceCropRect({ x: 40, y: 40, width: 20, height: 20 }, 100, 100)).toBeNull();
  });
});

describe("laplacianVariance", () => {
  it("is zero on a flat field", () => {
    const flat = new Float64Array(10 * 10).fill(128);
    expect(laplacianVariance(flat, 10, 10)).toBe(0);
  });

  it("is larger for a hard edge pattern than for a soft gradient", () => {
    const size = 32;
    const checker = new Float64Array(size * size);
    const gradient = new Float64Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        checker[y * size + x] = (x + y) % 2 === 0 ? 0 : 255;
        gradient[y * size + x] = (x / size) * 255;
      }
    }
    expect(laplacianVariance(checker, size, size)).toBeGreaterThan(
      laplacianVariance(gradient, size, size),
    );
  });

  it("returns 0 for inputs too small to have an interior", () => {
    expect(laplacianVariance(new Float64Array(4), 2, 2)).toBe(0);
  });
});

describe("normalizeSharpness", () => {
  it("maps the full-scale variance to 1 and saturates above it", () => {
    expect(normalizeSharpness(LAPLACIAN_FULL_SCALE)).toBe(1);
    expect(normalizeSharpness(LAPLACIAN_FULL_SCALE * 10)).toBe(1);
    expect(normalizeSharpness(LAPLACIAN_FULL_SCALE / 2)).toBeCloseTo(0.5, 6);
  });

  it("floors non-positive and non-finite variances at 0", () => {
    expect(normalizeSharpness(0)).toBe(0);
    expect(normalizeSharpness(-1)).toBe(0);
    expect(normalizeSharpness(Number.NaN)).toBe(0);
  });
});

const tmpDir = "uploads/test-face-sharpness";

/**
 * A 400×400 test image whose left half carries fine detail (in focus) and
 * whose right half is the same pattern blurred (out of focus). Written as PNG
 * so JPEG ringing doesn't add edges of its own to the blurred side.
 */
async function writeSplitFocusImage(filePath: string): Promise<void> {
  const size = 400;
  const block = 8;
  const raw = Buffer.alloc(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 8 px blocks rather than a 1 px checker: the measurement resamples
      // every crop to 128×128, and a single-pixel pattern would alias into a
      // flat grey there instead of surviving as detail.
      raw[y * size + x] =
        (Math.floor(x / block) + Math.floor(y / block)) % 2 === 0 ? 0 : 255;
    }
  }
  const detailed = await sharp(raw, { raw: { width: size, height: size, channels: 1 } })
    .png()
    .toBuffer();
  const blurredRightHalf = await sharp(raw, {
    raw: { width: size, height: size, channels: 1 },
  })
    .blur(8)
    .extract({ left: size / 2, top: 0, width: size / 2, height: size })
    .png()
    .toBuffer();
  await sharp(detailed)
    .composite([{ input: blurredRightHalf, left: size / 2, top: 0 }])
    .png()
    .toFile(filePath);
}

describe("measureFaceSharpness", () => {
  const filePath = path.join(tmpDir, "split-focus.png");

  beforeEach(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    if (!fs.existsSync(filePath)) await writeSplitFocusImage(filePath);
  });

  it("scores a sharp region above a blurred one on the same photo", async () => {
    const image = await loadGrayImage(filePath);
    expect(image.width).toBe(400);
    const sharpFace = await measureFaceSharpness(image, {
      x: 0.05,
      y: 0.3,
      width: 0.3,
      height: 0.3,
    });
    const blurredFace = await measureFaceSharpness(image, {
      x: 0.65,
      y: 0.3,
      width: 0.3,
      height: 0.3,
    });
    expect(sharpFace).not.toBeNull();
    expect(blurredFace).not.toBeNull();
    expect(sharpFace!).toBeGreaterThan(blurredFace!);
    expect(sharpFace!).toBeLessThanOrEqual(1);
    expect(blurredFace!).toBeGreaterThanOrEqual(0);
  });

  it("returns null — not 0 — for a face too small to judge", async () => {
    const image = await loadGrayImage(filePath);
    // 0.01 × 400 px = 4 px, below MIN_FACE_PIXELS.
    const result = await measureFaceSharpness(image, {
      x: 0.5,
      y: 0.5,
      width: 0.01,
      height: 0.01,
    });
    expect(result).toBeNull();
  });

  it("resamples every crop to the same measurement size", async () => {
    const image = await loadGrayImage(filePath);
    // Two different crop sizes over the same (uniformly detailed) region
    // must land in the same ballpark, because both are resampled to
    // FACE_SAMPLE_SIZE before the variance is taken.
    expect(FACE_SAMPLE_SIZE).toBe(128);
    const small = await measureFaceSharpness(image, { x: 0.05, y: 0.05, width: 0.15, height: 0.15 });
    const large = await measureFaceSharpness(image, { x: 0.05, y: 0.05, width: 0.4, height: 0.4 });
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
  });
});

describe("backfillFaceSharpnessLogic", () => {
  let userId: number;
  let photoId: number;
  const filePath = path.join(tmpDir, "backfill.png");

  beforeEach(async () => {
    await db.delete(faces);
    await db.delete(photos);
    await db.delete(users);
    fs.mkdirSync(tmpDir, { recursive: true });
    if (!fs.existsSync(filePath)) await writeSplitFocusImage(filePath);

    const u = await createUserLogic({
      email: `fs-${Date.now()}@example.com`,
      name: "FS",
      password: "pw",
    });
    userId = u.id;
    const created = await dbInsertReturning<{ id: number }>(
      db.insert(photos)
        .values({
          user_id: userId,
          filename: filePath,
          original_name: "backfill.png",
          mime_type: "image/png",
          size: 1024,
          width: 400,
          height: 400,
          external_path: filePath,
        })
        .returning({ id: photos.id }),
    );
    photoId = created!.id;
  });

  afterAll(async () => {
    await db.delete(faces);
    await db.delete(photos);
    await db.delete(users);
  });

  it("measures every unmeasured face and reports the pass as complete", async () => {
    await db.insert(faces).values([
      {
        photo_id: photoId,
        bbox: JSON.stringify({ x: 0.05, y: 0.3, width: 0.3, height: 0.3 }),
        embedding: JSON.stringify([]),
      },
      {
        photo_id: photoId,
        bbox: JSON.stringify({ x: 0.65, y: 0.3, width: 0.3, height: 0.3 }),
        embedding: JSON.stringify([]),
      },
    ]);

    const result = await backfillFaceSharpnessLogic({ userId });
    expect(result.photos_scanned).toBe(1);
    expect(result.faces_updated).toBe(2);
    expect(result.photos_failed).toBe(0);
    expect(result.next_photo_id).toBeNull();

    const rows = await db.select().from(faces).where(eq(faces.photo_id, photoId));
    const scores = rows.map((r) => r.sharpness!).sort((a, b) => a - b);
    expect(scores.every((s) => s != null)).toBe(true);
    // Sharp half above blurred half — the whole point of measuring per face.
    expect(scores[1]).toBeGreaterThan(scores[0]);
  });

  it("leaves faces too small to judge at NULL and counts them separately", async () => {
    await db.insert(faces).values({
      photo_id: photoId,
      bbox: JSON.stringify({ x: 0.5, y: 0.5, width: 0.01, height: 0.01 }),
      embedding: JSON.stringify([]),
    });

    const result = await backfillFaceSharpnessLogic({ userId });
    expect(result.faces_updated).toBe(0);
    expect(result.faces_skipped).toBe(1);

    const rows = await db.select().from(faces).where(eq(faces.photo_id, photoId));
    expect(rows[0]!.sharpness).toBeNull();
  });

  it("is idempotent — a second pass finds nothing left to measure", async () => {
    await db.insert(faces).values({
      photo_id: photoId,
      bbox: JSON.stringify({ x: 0.05, y: 0.3, width: 0.3, height: 0.3 }),
      embedding: JSON.stringify([]),
    });

    const first = await backfillFaceSharpnessLogic({ userId });
    expect(first.faces_updated).toBe(1);
    const second = await backfillFaceSharpnessLogic({ userId });
    expect(second.photos_scanned).toBe(0);
    expect(second.faces_updated).toBe(0);
  });

  it("hands back a cursor while photos remain", async () => {
    // `photos.external_path` is unique, so the second photo needs a file of
    // its own — a copy of the same test image.
    const secondPath = path.join(tmpDir, "backfill-2.png");
    fs.copyFileSync(filePath, secondPath);
    const second = await dbInsertReturning<{ id: number }>(
      db.insert(photos)
        .values({
          user_id: userId,
          filename: secondPath,
          original_name: "backfill-2.png",
          mime_type: "image/png",
          size: 1024,
          width: 400,
          height: 400,
          external_path: secondPath,
        })
        .returning({ id: photos.id }),
    );
    const bbox = JSON.stringify({ x: 0.05, y: 0.3, width: 0.3, height: 0.3 });
    await db.insert(faces).values([
      { photo_id: photoId, bbox, embedding: JSON.stringify([]) },
      { photo_id: second!.id, bbox, embedding: JSON.stringify([]) },
    ]);

    const batch = await backfillFaceSharpnessLogic({ userId, limit: 1 });
    expect(batch.photos_scanned).toBe(1);
    expect(batch.next_photo_id).toBe(photoId);
    expect(batch.remaining_faces).toBe(1);

    const rest = await backfillFaceSharpnessLogic({
      userId,
      afterPhotoId: batch.next_photo_id!,
      limit: 1,
    });
    expect(rest.faces_updated).toBe(1);
    expect(rest.remaining_faces).toBe(0);
  });
});
