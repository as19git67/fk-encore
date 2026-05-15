// Constraint tests for the photo_transforms / photo_transform_suggestions
// tables added in migration 0085. The feature itself (suggestion compute,
// render endpoint, editor UI) lands in later phases; this file pins down
// the DB invariants so subsequent phases can rely on them.

import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import db from "../db/database";
import {
  photos,
  photoTransforms,
  photoTransformSuggestions,
  users,
  type PhotoTransformSuggestionsPayload,
} from "../db/schema";
import { dbInsertReturning } from "../db/adapter";
import { createUserLogic } from "../user/user.service";

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
