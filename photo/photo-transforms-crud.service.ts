// Photo transformations — Phase 4a: per-user CRUD + adopt + materialize-suggestion.
//
// Reads / writes / deletes rows in photo_transforms scoped to the calling
// user. The "others" list in the get-bundle response drives the adopt
// banner in the editor; the suggestion payload sits alongside so the UI
// can render the AI variant without a second request.

import { eq, and, ne } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbFirst, dbExec, dbInsertReturning } from "../db/adapter";
import {
  photos,
  photoTransforms,
  photoTransformSuggestions,
  users,
  type PhotoTransformAspectRatio,
  type PhotoTransformCrop,
  type PhotoTransformSuggestionsPayload,
} from "../db/schema";
import { APIError } from "encore.dev/api";

// ----------------- DTO types -----------------

export type PhotoTransformSource = "user" | "ai" | "adopted";

export interface PhotoTransformRow {
  id: number;
  photo_id: number;
  user_id: number;
  source: PhotoTransformSource;
  adopted_from: number | null;
  crop: PhotoTransformCrop | null;
  rotation: number;
  exposure: number;
  contrast: number;
  gamma: number;
  white_point: number | null;
  black_point: number | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PhotoTransformOther extends PhotoTransformRow {
  user: { id: number; name: string };
}

export interface PhotoTransformsBundle {
  mine: PhotoTransformRow | null;
  others: PhotoTransformOther[];
  suggestion: PhotoTransformSuggestionsPayload | null;
  model_version: string | null;
}

export interface UpsertTransformRequest {
  crop?: PhotoTransformCrop | null;
  rotation?: number;
  exposure?: number;
  contrast?: number;
  gamma?: number;
  white_point?: number | null;
  black_point?: number | null;
}

const VALID_ROTATIONS = new Set([0, 90, 180, 270]);

// ----------------- Validation -----------------

/**
 * Validate an UpsertTransformRequest. Throws APIError.invalidArgument with
 * a descriptive message on the first failure. Pure — no DB access.
 */
export function validateUpsertRequest(body: UpsertTransformRequest): void {
  if (body.rotation !== undefined && !VALID_ROTATIONS.has(body.rotation)) {
    throw APIError.invalidArgument("rotation must be 0, 90, 180, or 270");
  }
  if (body.exposure !== undefined && !inRange(body.exposure, -3, 3)) {
    throw APIError.invalidArgument("exposure must be in [-3, +3]");
  }
  if (body.contrast !== undefined && !inRange(body.contrast, -1, 1)) {
    throw APIError.invalidArgument("contrast must be in [-1, +1]");
  }
  if (body.gamma !== undefined && !inRange(body.gamma, 0.1, 5)) {
    throw APIError.invalidArgument("gamma must be in [0.1, 5]");
  }
  if (body.white_point != null && !inRange(body.white_point, 0, 1)) {
    throw APIError.invalidArgument("white_point must be in [0, 1]");
  }
  if (body.black_point != null && !inRange(body.black_point, 0, 1)) {
    throw APIError.invalidArgument("black_point must be in [0, 1]");
  }
  if (
    body.white_point != null &&
    body.black_point != null &&
    body.black_point >= body.white_point
  ) {
    throw APIError.invalidArgument("black_point must be < white_point");
  }
  if (body.crop !== undefined && body.crop !== null) {
    const c = body.crop;
    if (!inRange(c.x, 0, 1) || !inRange(c.y, 0, 1)) {
      throw APIError.invalidArgument("crop x and y must be in [0, 1]");
    }
    if (!(c.w > 0) || !(c.h > 0)) {
      throw APIError.invalidArgument("crop w and h must be > 0");
    }
    if (c.x + c.w > 1 + 1e-6 || c.y + c.h > 1 + 1e-6) {
      throw APIError.invalidArgument("crop must lie inside the image");
    }
  }
}

function inRange(n: number, lo: number, hi: number): boolean {
  return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
}

// ----------------- Internal helpers -----------------

async function assertPhotoExists(photoId: number): Promise<void> {
  const row = await dbFirst<{ id: number }>(
    db.select({ id: photos.id }).from(photos).where(eq(photos.id, photoId)),
  );
  if (!row) {
    throw APIError.notFound(`photo ${photoId} not found`);
  }
}

function rowFromDb(r: typeof photoTransforms.$inferSelect): PhotoTransformRow {
  return {
    id: r.id,
    photo_id: r.photo_id,
    user_id: r.user_id,
    source: r.source as PhotoTransformSource,
    adopted_from: r.adopted_from ?? null,
    crop: (r.crop as PhotoTransformCrop | null) ?? null,
    rotation: r.rotation,
    exposure: r.exposure,
    contrast: r.contrast,
    gamma: r.gamma,
    white_point: r.white_point,
    black_point: r.black_point,
    applied_at: r.applied_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ----------------- Public logic -----------------

/**
 * Returns the full transforms bundle for a photo:
 *   - the caller's own transform (if any),
 *   - other users' transforms (with their display name),
 *   - the AI suggestion payload + model version (if any).
 * The bundle drives both the editor's main view and the adopt banner.
 */
export async function getPhotoTransformsLogic(
  userId: number,
  photoId: number,
): Promise<PhotoTransformsBundle> {
  await assertPhotoExists(photoId);

  const mineRow = await dbFirst<typeof photoTransforms.$inferSelect>(
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

  const othersRows = await dbAll<
    typeof photoTransforms.$inferSelect & { user_name: string }
  >(
    db
      .select({
        id: photoTransforms.id,
        photo_id: photoTransforms.photo_id,
        user_id: photoTransforms.user_id,
        source: photoTransforms.source,
        adopted_from: photoTransforms.adopted_from,
        crop: photoTransforms.crop,
        rotation: photoTransforms.rotation,
        exposure: photoTransforms.exposure,
        contrast: photoTransforms.contrast,
        gamma: photoTransforms.gamma,
        white_point: photoTransforms.white_point,
        black_point: photoTransforms.black_point,
        applied_at: photoTransforms.applied_at,
        created_at: photoTransforms.created_at,
        updated_at: photoTransforms.updated_at,
        user_name: users.name,
      })
      .from(photoTransforms)
      .innerJoin(users, eq(users.id, photoTransforms.user_id))
      .where(
        and(
          eq(photoTransforms.photo_id, photoId),
          ne(photoTransforms.user_id, userId),
        ),
      ),
  );

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

  return {
    mine: mineRow ? rowFromDb(mineRow) : null,
    others: othersRows.map((r) => ({
      ...rowFromDb(r),
      user: { id: r.user_id, name: r.user_name },
    })),
    suggestion: suggestion?.payload ?? null,
    model_version: suggestion?.model_version ?? null,
  };
}

/**
 * Upsert the caller's user-edited transform. `source` is always 'user';
 * adopt and materialize-suggestion use dedicated endpoints below.
 */
export async function upsertOwnTransformLogic(
  userId: number,
  photoId: number,
  body: UpsertTransformRequest,
): Promise<PhotoTransformRow> {
  validateUpsertRequest(body);
  await assertPhotoExists(photoId);

  const existing = await dbFirst<typeof photoTransforms.$inferSelect>(
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

  if (existing) {
    const merged = {
      crop: body.crop !== undefined ? body.crop : existing.crop,
      rotation: body.rotation ?? existing.rotation,
      exposure: body.exposure ?? existing.exposure,
      contrast: body.contrast ?? existing.contrast,
      gamma: body.gamma ?? existing.gamma,
      white_point: body.white_point !== undefined ? body.white_point : existing.white_point,
      black_point: body.black_point !== undefined ? body.black_point : existing.black_point,
      source: "user" as const,
      adopted_from: null,
      updated_at: new Date().toISOString(),
    };
    await dbExec(
      db
        .update(photoTransforms)
        .set(merged)
        .where(eq(photoTransforms.id, existing.id)),
    );
    const updated = await dbFirst<typeof photoTransforms.$inferSelect>(
      db.select().from(photoTransforms).where(eq(photoTransforms.id, existing.id)),
    );
    return rowFromDb(updated!);
  }

  const created = await dbInsertReturning<typeof photoTransforms.$inferSelect>(
    db
      .insert(photoTransforms)
      .values({
        photo_id: photoId,
        user_id: userId,
        source: "user",
        crop: body.crop ?? null,
        rotation: body.rotation ?? 0,
        exposure: body.exposure ?? 0,
        contrast: body.contrast ?? 0,
        gamma: body.gamma ?? 1,
        white_point: body.white_point ?? null,
        black_point: body.black_point ?? null,
      })
      .returning(),
  );
  return rowFromDb(created!);
}

/**
 * Delete the caller's transform. Returns `deleted: true` whether a row
 * existed or not — the operation is idempotent.
 */
export async function deleteOwnTransformLogic(
  userId: number,
  photoId: number,
): Promise<{ deleted: boolean }> {
  await dbExec(
    db
      .delete(photoTransforms)
      .where(
        and(
          eq(photoTransforms.photo_id, photoId),
          eq(photoTransforms.user_id, userId),
        ),
      ),
  );
  return { deleted: true };
}

/**
 * Materialize the AI suggestion as the caller's transform. Picks the crop
 * for `ratio` (must be present in the suggestion payload) and copies the
 * exposure / contrast / gamma values. Replaces any existing user row for
 * this photo. Marked `source = 'ai'`.
 */
export async function materializeSuggestionLogic(
  userId: number,
  photoId: number,
  ratio: PhotoTransformAspectRatio,
): Promise<PhotoTransformRow> {
  await assertPhotoExists(photoId);
  const suggestion = await dbFirst<{ payload: PhotoTransformSuggestionsPayload }>(
    db
      .select({ payload: photoTransformSuggestions.payload })
      .from(photoTransformSuggestions)
      .where(eq(photoTransformSuggestions.photo_id, photoId)),
  );
  if (!suggestion) {
    throw APIError.notFound(`no AI suggestion exists for photo ${photoId}`);
  }
  const crop = suggestion.payload.crops[ratio];
  if (!crop) {
    throw APIError.failedPrecondition(
      `suggestion for photo ${photoId} has no crop for aspect ratio ${ratio}`,
    );
  }

  const payload = suggestion.payload;
  return await upsertWithSource(userId, photoId, "ai", null, {
    crop,
    rotation: 0,
    exposure: payload.exposure,
    contrast: payload.contrast,
    gamma: payload.gamma,
    white_point: payload.white_point ?? null,
    black_point: payload.black_point ?? null,
  });
}

/**
 * Adopt another user's transform as the caller's. Copies the recipe and
 * records the source via `adopted_from`. Replaces any existing user row.
 */
export async function adoptTransformLogic(
  userId: number,
  photoId: number,
  fromTransformId: number,
): Promise<PhotoTransformRow> {
  await assertPhotoExists(photoId);
  const source = await dbFirst<typeof photoTransforms.$inferSelect>(
    db
      .select()
      .from(photoTransforms)
      .where(eq(photoTransforms.id, fromTransformId)),
  );
  if (!source) {
    throw APIError.notFound(`transform ${fromTransformId} not found`);
  }
  if (source.photo_id !== photoId) {
    throw APIError.failedPrecondition(
      `transform ${fromTransformId} belongs to a different photo`,
    );
  }
  if (source.user_id === userId) {
    throw APIError.failedPrecondition("cannot adopt your own transform");
  }

  return await upsertWithSource(userId, photoId, "adopted", source.id, {
    crop: source.crop as PhotoTransformCrop | null,
    rotation: source.rotation,
    exposure: source.exposure,
    contrast: source.contrast,
    gamma: source.gamma,
    white_point: source.white_point,
    black_point: source.black_point,
  });
}

interface RecipeCore {
  crop: PhotoTransformCrop | null;
  rotation: number;
  exposure: number;
  contrast: number;
  gamma: number;
  white_point: number | null;
  black_point: number | null;
}

async function upsertWithSource(
  userId: number,
  photoId: number,
  source: PhotoTransformSource,
  adoptedFrom: number | null,
  recipe: RecipeCore,
): Promise<PhotoTransformRow> {
  const existing = await dbFirst<typeof photoTransforms.$inferSelect>(
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

  if (existing) {
    await dbExec(
      db
        .update(photoTransforms)
        .set({
          ...recipe,
          source,
          adopted_from: adoptedFrom,
          updated_at: new Date().toISOString(),
        })
        .where(eq(photoTransforms.id, existing.id)),
    );
    const updated = await dbFirst<typeof photoTransforms.$inferSelect>(
      db.select().from(photoTransforms).where(eq(photoTransforms.id, existing.id)),
    );
    return rowFromDb(updated!);
  }

  const created = await dbInsertReturning<typeof photoTransforms.$inferSelect>(
    db
      .insert(photoTransforms)
      .values({
        photo_id: photoId,
        user_id: userId,
        source,
        adopted_from: adoptedFrom ?? undefined,
        ...recipe,
      })
      .returning(),
  );
  return rowFromDb(created!);
}
