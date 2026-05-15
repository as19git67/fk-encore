// Tests for the Phase 4a CRUD service: get/upsert/delete/adopt/materialize.
//
// All tests call the service-logic functions directly (the HTTP layer is a
// thin wrapper, see photo.ts). Validation is exercised through the public
// API by passing invalid bodies — the validator throws APIError, which is
// the contract HTTP callers see.

import { describe, it, expect, beforeEach } from "vitest";
import { APIError } from "encore.dev/api";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import {
  photos,
  photoTransforms,
  photoTransformSuggestions,
  users,
  type PhotoTransformSuggestionsPayload,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import {
  adoptTransformLogic,
  deleteOwnTransformLogic,
  getPhotoTransformsLogic,
  materializeSuggestionLogic,
  upsertOwnTransformLogic,
  validateUpsertRequest,
} from "./photo-transforms-crud.service";

let userA: number;
let userB: number;
let photoId: number;

async function insertSuggestion(payload: PhotoTransformSuggestionsPayload) {
  await db
    .insert(photoTransformSuggestions)
    .values({ photo_id: photoId, payload, model_version: "v1" })
    .onConflictDoUpdate({
      target: photoTransformSuggestions.photo_id,
      set: { payload, model_version: "v1" },
    });
}

beforeEach(async () => {
  await db.delete(photoTransforms);
  await db.delete(photoTransformSuggestions);
  await db.delete(photos);
  await db.delete(users);

  userA = (
    await createUserLogic({
      email: `a-${Date.now()}@example.com`,
      name: "Alice",
      password: "pw",
    })
  ).id;
  userB = (
    await createUserLogic({
      email: `b-${Date.now()}@example.com`,
      name: "Bob",
      password: "pw",
    })
  ).id;

  const photo = await dbInsertReturning<{ id: number }>(
    db
      .insert(photos)
      .values({
        user_id: userA,
        filename: `crud-${Date.now()}.jpg`,
        original_name: "crud.jpg",
        mime_type: "image/jpeg",
        size: 1024,
        width: 400,
        height: 300,
      })
      .returning({ id: photos.id }),
  );
  photoId = photo!.id;
});

describe("validateUpsertRequest — pure", () => {
  it("accepts a complete, valid recipe", () => {
    expect(() =>
      validateUpsertRequest({
        crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        rotation: 90,
        exposure: 0.5,
        contrast: 0.2,
        gamma: 1.2,
        white_point: 0.95,
        black_point: 0.05,
      }),
    ).not.toThrow();
  });
  it("accepts an empty body (no fields)", () => {
    expect(() => validateUpsertRequest({})).not.toThrow();
  });
  it("rejects a non-90°-step rotation", () => {
    expect(() => validateUpsertRequest({ rotation: 45 })).toThrow(APIError);
  });
  it("rejects out-of-range exposure", () => {
    expect(() => validateUpsertRequest({ exposure: 10 })).toThrow(APIError);
  });
  it("rejects black_point >= white_point", () => {
    expect(() =>
      validateUpsertRequest({ white_point: 0.5, black_point: 0.5 }),
    ).toThrow(/black_point/);
  });
  it("rejects a crop with negative dims", () => {
    expect(() =>
      validateUpsertRequest({ crop: { x: 0, y: 0, w: -0.1, h: 0.5 } }),
    ).toThrow(/w and h/);
  });
  it("rejects a crop that overflows the image", () => {
    expect(() =>
      validateUpsertRequest({ crop: { x: 0.8, y: 0.8, w: 0.5, h: 0.5 } }),
    ).toThrow(/inside the image/);
  });
});

describe("getPhotoTransformsLogic", () => {
  it("returns a fully-null bundle when nothing exists", async () => {
    const r = await getPhotoTransformsLogic(userA, photoId);
    expect(r.mine).toBeNull();
    expect(r.others).toEqual([]);
    expect(r.suggestion).toBeNull();
    expect(r.model_version).toBeNull();
  });

  it("returns 404 for an unknown photo", async () => {
    await expect(getPhotoTransformsLogic(userA, 999_999)).rejects.toThrow(APIError);
  });

  it("returns the caller's own row in `mine` and excludes it from `others`", async () => {
    await upsertOwnTransformLogic(userA, photoId, { exposure: 0.5 });
    await upsertOwnTransformLogic(userB, photoId, { exposure: -0.5 });

    const aView = await getPhotoTransformsLogic(userA, photoId);
    expect(aView.mine?.user_id).toBe(userA);
    expect(aView.others).toHaveLength(1);
    expect(aView.others[0].user_id).toBe(userB);
    expect(aView.others[0].user.name).toBe("Bob");

    const bView = await getPhotoTransformsLogic(userB, photoId);
    expect(bView.mine?.user_id).toBe(userB);
    expect(bView.others).toHaveLength(1);
    expect(bView.others[0].user_id).toBe(userA);
    expect(bView.others[0].user.name).toBe("Alice");
  });

  it("includes the suggestion payload when present", async () => {
    await insertSuggestion({
      crops: { "1:1": { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } },
      exposure: 0.3,
      contrast: 0,
      gamma: 1,
    });
    const r = await getPhotoTransformsLogic(userA, photoId);
    expect(r.suggestion?.exposure).toBeCloseTo(0.3, 5);
    expect(r.model_version).toBe("v1");
  });
});

describe("upsertOwnTransformLogic", () => {
  it("creates a row with source='user' and default fields when none exists", async () => {
    const r = await upsertOwnTransformLogic(userA, photoId, {});
    expect(r.source).toBe("user");
    expect(r.rotation).toBe(0);
    expect(r.exposure).toBe(0);
    expect(r.crop).toBeNull();
  });

  it("updates the existing row on a second call (idempotent upsert)", async () => {
    const r1 = await upsertOwnTransformLogic(userA, photoId, { exposure: 0.5 });
    const r2 = await upsertOwnTransformLogic(userA, photoId, { contrast: 0.2 });
    expect(r2.id).toBe(r1.id);
    expect(r2.exposure).toBeCloseTo(0.5, 5); // preserved
    expect(r2.contrast).toBeCloseTo(0.2, 5);
  });

  it("resets source to 'user' even when overwriting an 'ai' or 'adopted' row", async () => {
    await insertSuggestion({
      crops: { "1:1": { x: 0, y: 0, w: 1, h: 1 } },
      exposure: 0.1,
      contrast: 0,
      gamma: 1,
    });
    const ai = await materializeSuggestionLogic(userA, photoId, "1:1");
    expect(ai.source).toBe("ai");

    const edited = await upsertOwnTransformLogic(userA, photoId, { exposure: 0.7 });
    expect(edited.source).toBe("user");
    expect(edited.adopted_from).toBeNull();
  });

  it("propagates validation errors", async () => {
    await expect(
      upsertOwnTransformLogic(userA, photoId, { rotation: 45 }),
    ).rejects.toThrow(APIError);
  });

  it("404s for an unknown photo", async () => {
    await expect(
      upsertOwnTransformLogic(userA, 999_999, { exposure: 0.5 }),
    ).rejects.toThrow(/not found/);
  });
});

describe("deleteOwnTransformLogic", () => {
  it("removes the caller's row", async () => {
    await upsertOwnTransformLogic(userA, photoId, { exposure: 0.5 });
    const r = await deleteOwnTransformLogic(userA, photoId);
    expect(r.deleted).toBe(true);
    const rows = await db
      .select()
      .from(photoTransforms)
      .where(eq(photoTransforms.photo_id, photoId));
    expect(rows).toHaveLength(0);
  });

  it("is idempotent — succeeds when there's nothing to delete", async () => {
    const r = await deleteOwnTransformLogic(userA, photoId);
    expect(r.deleted).toBe(true);
  });

  it("does not affect other users' rows", async () => {
    await upsertOwnTransformLogic(userA, photoId, { exposure: 0.5 });
    await upsertOwnTransformLogic(userB, photoId, { exposure: -0.5 });
    await deleteOwnTransformLogic(userA, photoId);
    const rows = await db
      .select()
      .from(photoTransforms)
      .where(eq(photoTransforms.photo_id, photoId));
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userB);
  });
});

describe("materializeSuggestionLogic", () => {
  beforeEach(async () => {
    await insertSuggestion({
      crops: {
        "1:1": { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        "16:9": { x: 0, y: 0.2, w: 1, h: 0.5 },
      },
      exposure: 0.3,
      contrast: 0.1,
      gamma: 1,
    });
  });

  it("copies the chosen ratio's crop and the exposure values, source='ai'", async () => {
    const r = await materializeSuggestionLogic(userA, photoId, "16:9");
    expect(r.source).toBe("ai");
    expect(r.crop).toEqual({ x: 0, y: 0.2, w: 1, h: 0.5 });
    expect(r.exposure).toBeCloseTo(0.3, 5);
    expect(r.adopted_from).toBeNull();
  });

  it("404s when no suggestion exists for the photo", async () => {
    await db.delete(photoTransformSuggestions);
    await expect(
      materializeSuggestionLogic(userA, photoId, "1:1"),
    ).rejects.toThrow(/no AI suggestion/);
  });

  it("fails_precondition when the chosen ratio isn't in the suggestion", async () => {
    await expect(
      materializeSuggestionLogic(userA, photoId, "9:16"),
    ).rejects.toThrow(/no crop for aspect ratio/);
  });
});

describe("adoptTransformLogic", () => {
  it("copies another user's recipe and records adopted_from", async () => {
    const bRow = await upsertOwnTransformLogic(userB, photoId, {
      exposure: 0.7,
      crop: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 },
    });
    const adopted = await adoptTransformLogic(userA, photoId, bRow.id);
    expect(adopted.source).toBe("adopted");
    expect(adopted.adopted_from).toBe(bRow.id);
    expect(adopted.exposure).toBeCloseTo(0.7, 5);
    expect(adopted.crop).toEqual({ x: 0.2, y: 0.2, w: 0.6, h: 0.6 });
  });

  it("survives source deletion (ON DELETE SET NULL on adopted_from)", async () => {
    const bRow = await upsertOwnTransformLogic(userB, photoId, { exposure: 0.7 });
    const adopted = await adoptTransformLogic(userA, photoId, bRow.id);
    await deleteOwnTransformLogic(userB, photoId);
    const after = await db
      .select()
      .from(photoTransforms)
      .where(eq(photoTransforms.id, adopted.id));
    expect(after).toHaveLength(1);
    expect(after[0].adopted_from).toBeNull();
    expect(after[0].exposure).toBeCloseTo(0.7, 5);
  });

  it("rejects adopting your own transform", async () => {
    const aRow = await upsertOwnTransformLogic(userA, photoId, { exposure: 0.5 });
    await expect(adoptTransformLogic(userA, photoId, aRow.id)).rejects.toThrow(
      /cannot adopt your own/,
    );
  });

  it("rejects adopting a transform on a different photo", async () => {
    const otherPhoto = await dbInsertReturning<{ id: number }>(
      db
        .insert(photos)
        .values({
          user_id: userB,
          filename: `other-${Date.now()}.jpg`,
          original_name: "other.jpg",
          mime_type: "image/jpeg",
          size: 100,
          width: 100,
          height: 100,
        })
        .returning({ id: photos.id }),
    );
    const bRow = await upsertOwnTransformLogic(userB, otherPhoto!.id, {
      exposure: 0.3,
    });
    await expect(adoptTransformLogic(userA, photoId, bRow.id)).rejects.toThrow(
      /different photo/,
    );
  });

  it("404s for an unknown transform id", async () => {
    await expect(adoptTransformLogic(userA, photoId, 999_999)).rejects.toThrow(
      /not found/,
    );
  });
});
