// Constraint tests for the photo_transforms / photo_transform_suggestions
// tables added in migration 0085, plus unit / integration tests for the
// suggestion-compute service added in phase 2.

import { describe, it, expect, beforeEach } from "vitest";
import sharp from "sharp";
import { eq, sql } from "drizzle-orm";
import db from "../db/database";
import {
  faces,
  photoLandmarks,
  photos,
  photoTransforms,
  photoTransformSuggestions,
  users,
  type PhotoTransformSuggestionsPayload,
} from "../db/schema";
import { dbInsertReturning } from "../db/adapter";
import { createUserLogic } from "../user/user.service";
import {
  PHOTO_TRANSFORM_MODEL_VERSION,
  PHOTO_TRANSFORM_ASPECT_RATIOS,
  computeAutoExposureFromStats,
  computePhotoTransformSuggestions,
  computeSubjectHull,
  computeSuggestionCrops,
  fitCropToAspect,
  padBbox,
  unionBbox,
  type BboxNorm,
} from "./photo-transforms.service";

async function createPhoto(userId: number): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db
      .insert(photos)
      .values({
        user_id: userId,
        filename: `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
        original_name: "test.jpg",
        mime_type: "image/jpeg",
        size: 1024,
      })
      .returning({ id: photos.id }),
  );
  return row!.id;
}

describe("photo_transforms / photo_transform_suggestions migration 0085", () => {
  let user1Id: number;
  let user2Id: number;
  let photoId: number;

  beforeEach(async () => {
    await db.delete(photoTransforms);
    await db.delete(photoTransformSuggestions);
    await db.delete(photos);
    await db.delete(users);

    const user1 = await createUserLogic({
      email: `t1-${Date.now()}@example.com`,
      name: "T1",
      password: "pw",
    });
    const user2 = await createUserLogic({
      email: `t2-${Date.now()}@example.com`,
      name: "T2",
      password: "pw",
    });
    user1Id = user1.id;
    user2Id = user2.id;
    photoId = await createPhoto(user1Id);
  });

  describe("photo_transform_suggestions", () => {
    it("stores and roundtrips a payload", async () => {
      const payload: PhotoTransformSuggestionsPayload = {
        crops: {
          "1:1": { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
          "16:9": { x: 0, y: 0.2, w: 1, h: 0.6 },
        },
        exposure: 0.3,
        contrast: 0.1,
        gamma: 1,
        white_point: 0.95,
        black_point: 0.02,
      };

      await db
        .insert(photoTransformSuggestions)
        .values({ photo_id: photoId, payload, model_version: "v1" });

      const row = await db
        .select()
        .from(photoTransformSuggestions)
        .where(eq(photoTransformSuggestions.photo_id, photoId))
        .then((r) => r[0]!);
      expect(row.payload).toEqual(payload);
      expect(row.model_version).toBe("v1");
      expect(row.computed_at).toBeTruthy();
    });

    it("cascades on photo delete", async () => {
      await db.insert(photoTransformSuggestions).values({
        photo_id: photoId,
        payload: { crops: {}, exposure: 0, contrast: 0, gamma: 1 },
        model_version: "v1",
      });
      await db.delete(photos).where(eq(photos.id, photoId));
      const rows = await db.select().from(photoTransformSuggestions);
      expect(rows).toHaveLength(0);
    });
  });

  describe("photo_transforms", () => {
    it("inserts a row with defaults", async () => {
      const row = await dbInsertReturning<{ id: number }>(
        db
          .insert(photoTransforms)
          .values({ photo_id: photoId, user_id: user1Id, source: "user" })
          .returning({ id: photoTransforms.id }),
      );
      const full = await db
        .select()
        .from(photoTransforms)
        .where(eq(photoTransforms.id, row!.id))
        .then((r) => r[0]!);
      expect(full.rotation).toBe(0);
      expect(full.exposure).toBe(0);
      expect(full.contrast).toBe(0);
      expect(full.gamma).toBe(1);
      expect(full.crop).toBeNull();
    });

    it("enforces UNIQUE (photo_id, user_id)", async () => {
      await db
        .insert(photoTransforms)
        .values({ photo_id: photoId, user_id: user1Id, source: "user" });
      await expect(
        db
          .insert(photoTransforms)
          .values({ photo_id: photoId, user_id: user1Id, source: "ai" }),
      ).rejects.toThrow();
    });

    it("allows different users on the same photo", async () => {
      await db
        .insert(photoTransforms)
        .values({ photo_id: photoId, user_id: user1Id, source: "user" });
      await db
        .insert(photoTransforms)
        .values({ photo_id: photoId, user_id: user2Id, source: "ai" });
      const rows = await db
        .select()
        .from(photoTransforms)
        .where(eq(photoTransforms.photo_id, photoId));
      expect(rows).toHaveLength(2);
    });

    it("rejects rotation outside {0, 90, 180, 270}", async () => {
      await expect(
        db.insert(photoTransforms).values({
          photo_id: photoId,
          user_id: user1Id,
          source: "user",
          rotation: 45,
        }),
      ).rejects.toThrow();
    });

    it("rejects unknown source value", async () => {
      await expect(
        db.insert(photoTransforms).values({
          photo_id: photoId,
          user_id: user1Id,
          source: "magic",
        }),
      ).rejects.toThrow();
    });

    it("sets adopted_from = NULL when the source row is deleted", async () => {
      const source = await dbInsertReturning<{ id: number }>(
        db
          .insert(photoTransforms)
          .values({ photo_id: photoId, user_id: user1Id, source: "user" })
          .returning({ id: photoTransforms.id }),
      );
      // Use raw SQL because adopted_from isn't in the Drizzle .values() type
      // unless we let the schema expose it (it's intentionally schema-only
      // for the self-FK case).
      await db.execute(sql`
        INSERT INTO photo_transforms (photo_id, user_id, source, adopted_from)
        VALUES (${photoId}, ${user2Id}, 'adopted', ${source!.id})
      `);

      await db.delete(photoTransforms).where(eq(photoTransforms.id, source!.id));

      const adopted = await db
        .select()
        .from(photoTransforms)
        .where(eq(photoTransforms.user_id, user2Id))
        .then((r) => r[0]!);
      expect(adopted).toBeTruthy();
      expect(adopted.adopted_from).toBeNull();
    });

    it("cascades on photo delete", async () => {
      await db
        .insert(photoTransforms)
        .values({ photo_id: photoId, user_id: user1Id, source: "user" });
      await db.delete(photos).where(eq(photos.id, photoId));
      const rows = await db.select().from(photoTransforms);
      expect(rows).toHaveLength(0);
    });

    it("cascades on user delete", async () => {
      await db
        .insert(photoTransforms)
        .values({ photo_id: photoId, user_id: user1Id, source: "user" });
      await db.delete(users).where(eq(users.id, user1Id));
      const rows = await db.select().from(photoTransforms);
      expect(rows).toHaveLength(0);
    });
  });
});

// ============================================================================
// Phase 2 — suggestion compute
// ============================================================================

function expectBboxClose(actual: BboxNorm | null, expected: BboxNorm, precision = 5) {
  expect(actual).not.toBeNull();
  expect(actual!.x).toBeCloseTo(expected.x, precision);
  expect(actual!.y).toBeCloseTo(expected.y, precision);
  expect(actual!.width).toBeCloseTo(expected.width, precision);
  expect(actual!.height).toBeCloseTo(expected.height, precision);
}

describe("suggestion compute — pure math", () => {
  describe("unionBbox", () => {
    it("returns null for empty input", () => {
      expect(unionBbox([])).toBeNull();
    });
    it("returns the single bbox for a one-element list", () => {
      const b: BboxNorm = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
      expectBboxClose(unionBbox([b]), b);
    });
    it("axis-aligned union of multiple bboxes", () => {
      const a: BboxNorm = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
      const b: BboxNorm = { x: 0.5, y: 0.5, width: 0.3, height: 0.3 };
      expectBboxClose(unionBbox([a, b]), { x: 0.1, y: 0.1, width: 0.7, height: 0.7 });
    });
  });

  describe("padBbox", () => {
    it("expands by ratio on every side and clamps to [0,1]", () => {
      const b: BboxNorm = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
      const p = padBbox(b, 0.5); // 50% padding → +0.1 each side
      expect(p.x).toBeCloseTo(0.3, 5);
      expect(p.y).toBeCloseTo(0.3, 5);
      expect(p.width).toBeCloseTo(0.4, 5);
      expect(p.height).toBeCloseTo(0.4, 5);
    });
    it("clamps when padding would push past the image edge", () => {
      const b: BboxNorm = { x: 0.05, y: 0.05, width: 0.1, height: 0.1 };
      const p = padBbox(b, 2); // 200% padding → 0.2 each side
      expect(p.x).toBe(0); // clamped
      expect(p.y).toBe(0);
      expect(p.x + p.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(p.y + p.height).toBeLessThanOrEqual(1 + 1e-9);
    });
  });

  describe("computeSubjectHull", () => {
    it("returns null when neither faces nor landmarks exist", () => {
      expect(computeSubjectHull([], [])).toBeNull();
    });
    it("prefers faces over landmarks", () => {
      const face: BboxNorm = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
      const landmark = {
        bbox: { x: 0, y: 0, width: 1, height: 1 } as BboxNorm,
        confidence: 0.99,
      };
      expectBboxClose(computeSubjectHull([face], [landmark]), face);
    });
    it("falls back to highest-confidence landmark", () => {
      const lmA = {
        bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } as BboxNorm,
        confidence: 0.3,
      };
      const lmB = {
        bbox: { x: 0.6, y: 0.6, width: 0.3, height: 0.3 } as BboxNorm,
        confidence: 0.9,
      };
      expectBboxClose(computeSubjectHull([], [lmA, lmB]), lmB.bbox);
    });
  });

  describe("fitCropToAspect", () => {
    it("returns a crop containing the hull at the requested pixel aspect", () => {
      // Square image, target 16:9 crop, centred small hull.
      const hull: BboxNorm = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
      const crop = fitCropToAspect(hull, 16 / 9, 1.0);
      expect(crop).not.toBeNull();
      // Pixel aspect of crop in this square image: w/h.
      expect(crop!.w / crop!.h).toBeCloseTo(16 / 9, 4);
      // Hull fully inside.
      expect(hull.x).toBeGreaterThanOrEqual(crop!.x - 1e-6);
      expect(hull.x + hull.width).toBeLessThanOrEqual(crop!.x + crop!.w + 1e-6);
      expect(hull.y).toBeGreaterThanOrEqual(crop!.y - 1e-6);
      expect(hull.y + hull.height).toBeLessThanOrEqual(crop!.y + crop!.h + 1e-6);
    });
    it("returns null when the hull cannot fit at the requested ratio", () => {
      // Hull is a wide strip that cannot fit a 9:16 (portrait) crop in a
      // landscape image without the crop overflowing.
      const hull: BboxNorm = { x: 0.05, y: 0.4, width: 0.9, height: 0.2 };
      const crop = fitCropToAspect(hull, 9 / 16, 16 / 9);
      expect(crop).toBeNull();
    });
    it("respects the [0,1] bounds after clamping", () => {
      // Hull near a corner — crop should clamp to the edge, not overflow.
      const hull: BboxNorm = { x: 0.85, y: 0.85, width: 0.1, height: 0.1 };
      const crop = fitCropToAspect(hull, 1.0, 1.0);
      expect(crop).not.toBeNull();
      expect(crop!.x).toBeGreaterThanOrEqual(0);
      expect(crop!.y).toBeGreaterThanOrEqual(0);
      expect(crop!.x + crop!.w).toBeLessThanOrEqual(1 + 1e-6);
      expect(crop!.y + crop!.h).toBeLessThanOrEqual(1 + 1e-6);
    });
  });

  describe("computeSuggestionCrops", () => {
    it("returns centred crops for every fitting ratio when no hull", () => {
      const crops = computeSuggestionCrops(null, 4000, 3000); // 4:3 image
      // 1:1 fits, 4:3 fits, 16:9 fits, 4:5 fits (taller-than-image collapses
      // to a narrower-than-image crop), etc.
      expect(crops["1:1"]).toBeTruthy();
      expect(crops["4:3"]).toBeTruthy();
      expect(crops["16:9"]).toBeTruthy();
    });
    it("produces crops for ratios that fit the hull", () => {
      // 4000×3000 image (4:3), small face hull in the centre.
      const hull: BboxNorm = { x: 0.45, y: 0.4, width: 0.1, height: 0.15 };
      const crops = computeSuggestionCrops(hull, 4000, 3000);
      // Should at minimum produce a 1:1, a 4:3, a 16:9 and a 3:4 entry.
      expect(Object.keys(crops).length).toBeGreaterThanOrEqual(4);
      for (const [name, crop] of Object.entries(crops)) {
        // Pixel-space aspect ratio sanity-check.
        const expected = PHOTO_TRANSFORM_ASPECT_RATIOS[name as keyof typeof PHOTO_TRANSFORM_ASPECT_RATIOS];
        const actual = (crop.w * 4000) / (crop.h * 3000);
        expect(actual).toBeCloseTo(expected, 3);
        // Hull contained.
        expect(hull.x).toBeGreaterThanOrEqual(crop.x - 1e-6);
        expect(hull.x + hull.width).toBeLessThanOrEqual(crop.x + crop.w + 1e-6);
      }
    });
  });

  describe("computeAutoExposureFromStats", () => {
    it("returns 0 exposure / 0 contrast at the target mid-tone & stdev", () => {
      const r = computeAutoExposureFromStats(0.5, 0.22);
      expect(r.exposure).toBeCloseTo(0, 5);
      expect(r.contrast).toBeCloseTo(0, 5);
      expect(r.gamma).toBe(1);
    });
    it("brightens dark images", () => {
      const r = computeAutoExposureFromStats(0.15, 0.2);
      expect(r.exposure).toBeGreaterThan(0.5);
    });
    it("darkens bright images", () => {
      const r = computeAutoExposureFromStats(0.85, 0.2);
      expect(r.exposure).toBeLessThan(-0.5);
    });
    it("clamps to the configured range", () => {
      const veryDark = computeAutoExposureFromStats(0.01, 0.1);
      const veryBright = computeAutoExposureFromStats(0.99, 0.1);
      expect(veryDark.exposure).toBeLessThanOrEqual(1.5);
      expect(veryBright.exposure).toBeGreaterThanOrEqual(-1.5);
    });
    it("raises contrast for low-stdev (flat) images", () => {
      const r = computeAutoExposureFromStats(0.5, 0.05);
      expect(r.contrast).toBeGreaterThan(0);
    });
  });
});

// ----------------- Integration: compute + persist -----------------

describe("computePhotoTransformSuggestions", () => {
  let userId: number;
  let photoId: number;
  const tmpDir = "/tmp/fk-encore-suggestion-test";

  beforeEach(async () => {
    await db.delete(faces);
    await db.delete(photoLandmarks);
    await db.delete(photoTransformSuggestions);
    await db.delete(photos);
    await db.delete(users);

    const u = await createUserLogic({
      email: `s-${Date.now()}@example.com`,
      name: "S",
      password: "pw",
    });
    userId = u.id;

    // Generate a small grey 200×100 JPEG (2:1 image) so sharp.stats() has
    // something to read; the file path is filled into photos.external_path
    // to bypass the UPLOAD_DIR convention.
    const fs = await import("fs");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = `${tmpDir}/test-${Date.now()}.jpg`;
    await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 3,
        background: { r: 60, g: 60, b: 60 },
      },
    })
      .jpeg()
      .toFile(filePath);

    const created = await dbInsertReturning<{ id: number }>(
      db
        .insert(photos)
        .values({
          user_id: userId,
          filename: filePath,
          original_name: "test.jpg",
          mime_type: "image/jpeg",
          size: 1024,
          width: 200,
          height: 100,
          external_path: filePath,
        })
        .returning({ id: photos.id }),
    );
    photoId = created!.id;
  });

  it("writes a suggestion row with crops for every ratio that fits", async () => {
    // Add a face in the upper-left third.
    await db.insert(faces).values({
      photo_id: photoId,
      bbox: JSON.stringify({ x: 0.2, y: 0.2, width: 0.2, height: 0.4 }),
      embedding: JSON.stringify(new Array(512).fill(0)),
    });

    const payload = await computePhotoTransformSuggestions(photoId);
    expect(payload).not.toBeNull();
    expect(payload!.exposure).toBeGreaterThan(0); // dark grey → brighten
    expect(Object.keys(payload!.crops).length).toBeGreaterThanOrEqual(3);

    const row = await db
      .select()
      .from(photoTransformSuggestions)
      .where(eq(photoTransformSuggestions.photo_id, photoId))
      .then((r) => r[0]!);
    expect(row.model_version).toBe(PHOTO_TRANSFORM_MODEL_VERSION);
    expect(row.payload.crops).toEqual(payload!.crops);
  });

  it("is idempotent — second call upserts the same row", async () => {
    await computePhotoTransformSuggestions(photoId);
    await computePhotoTransformSuggestions(photoId);
    const rows = await db
      .select()
      .from(photoTransformSuggestions)
      .where(eq(photoTransformSuggestions.photo_id, photoId));
    expect(rows).toHaveLength(1);
  });

  it("returns null and writes nothing when photo dimensions are missing", async () => {
    await db.update(photos).set({ width: null, height: null }).where(eq(photos.id, photoId));
    const payload = await computePhotoTransformSuggestions(photoId);
    expect(payload).toBeNull();
    const rows = await db
      .select()
      .from(photoTransformSuggestions)
      .where(eq(photoTransformSuggestions.photo_id, photoId));
    expect(rows).toHaveLength(0);
  });

  it("falls back to a centred crop when no faces or landmarks exist", async () => {
    const payload = await computePhotoTransformSuggestions(photoId);
    expect(payload).not.toBeNull();
    // For a 2:1 landscape image, a 1:1 centred crop should be at x ≈ 0.25.
    const oneByOne = payload!.crops["1:1"];
    expect(oneByOne).toBeTruthy();
    expect(oneByOne!.x).toBeCloseTo(0.25, 2);
    expect(oneByOne!.y).toBeCloseTo(0, 2);
  });
});

describe("recomputeAllTransformSuggestionsLogic", () => {
  let userId: number;
  const tmpDir = "/tmp/fk-encore-suggestion-bulk-test";

  beforeEach(async () => {
    await db.delete(faces);
    await db.delete(photoLandmarks);
    await db.delete(photoTransformSuggestions);
    await db.delete(photos);
    await db.delete(users);

    const u = await createUserLogic({
      email: `bulk-${Date.now()}@example.com`,
      name: "B",
      password: "pw",
    });
    userId = u.id;
  });

  async function makePhotoOnDisk(suffix: string, width: number, height: number) {
    const fs = await import("fs");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = `${tmpDir}/bulk-${Date.now()}-${suffix}.jpg`;
    await sharp({
      create: { width, height, channels: 3, background: { r: 60, g: 60, b: 60 } },
    })
      .jpeg()
      .toFile(filePath);
    const row = await dbInsertReturning<{ id: number }>(
      db
        .insert(photos)
        .values({
          user_id: userId,
          filename: filePath,
          original_name: `${suffix}.jpg`,
          mime_type: "image/jpeg",
          size: 1024,
          width,
          height,
          external_path: filePath,
        })
        .returning({ id: photos.id }),
    );
    return row!.id;
  }

  it("writes a suggestion row for every photo the user owns", async () => {
    const { recomputeAllTransformSuggestionsLogic } = await import("./photo.service");
    const a = await makePhotoOnDisk("a", 200, 100);
    const b = await makePhotoOnDisk("b", 300, 200);
    const result = await recomputeAllTransformSuggestionsLogic(userId);
    expect(result.total).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0);
    const rows = await db
      .select()
      .from(photoTransformSuggestions)
      .where(eq(photoTransformSuggestions.photo_id, a));
    expect(rows).toHaveLength(1);
    const rowsB = await db
      .select()
      .from(photoTransformSuggestions)
      .where(eq(photoTransformSuggestions.photo_id, b));
    expect(rowsB).toHaveLength(1);
  });

  it("counts photos with missing dimensions as failed but does not abort", async () => {
    const { recomputeAllTransformSuggestionsLogic } = await import("./photo.service");
    const a = await makePhotoOnDisk("ok", 200, 100);
    // Insert a photo without width/height — compute returns null → counted as failed.
    const broken = await dbInsertReturning<{ id: number }>(
      db
        .insert(photos)
        .values({
          user_id: userId,
          filename: `${tmpDir}/missing.jpg`,
          original_name: "missing.jpg",
          mime_type: "image/jpeg",
          size: 100,
          external_path: `${tmpDir}/missing.jpg`,
        })
        .returning({ id: photos.id }),
    );
    const result = await recomputeAllTransformSuggestionsLogic(userId);
    expect(result.total).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.failed).toBe(1);
    // The ok photo got its suggestion.
    expect(
      (
        await db
          .select()
          .from(photoTransformSuggestions)
          .where(eq(photoTransformSuggestions.photo_id, a))
      ).length,
    ).toBe(1);
    // The broken one didn't.
    expect(
      (
        await db
          .select()
          .from(photoTransformSuggestions)
          .where(eq(photoTransformSuggestions.photo_id, broken!.id))
      ).length,
    ).toBe(0);
  });

  it("returns total:0 when the user has no photos", async () => {
    const { recomputeAllTransformSuggestionsLogic } = await import("./photo.service");
    const result = await recomputeAllTransformSuggestionsLogic(userId);
    expect(result).toEqual({ updated: 0, failed: 0, total: 0 });
  });
});
