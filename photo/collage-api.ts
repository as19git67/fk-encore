/**
 * POST /photos/collage — renders a collage from photos the caller may see and
 * files it as a new photo of the caller, dated one second after the newest
 * source. The assistant's `create_photo_collage` runs it when the user
 * confirms the proposal; the app's own collage dialog renders in the browser
 * and uploads the JPEG instead.
 */

import * as path from "path";
import { api, APIError } from "encore.dev/api";
import { eq, inArray } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { photos } from "../db/schema";
import { resolvePhotoFilePath } from "./photo";
import { PhotoAlreadyExistsError, uploadPhotoLogic } from "./photo.service";
import { assertPhotoAccess } from "./photo-file-access";
import { convertHeicToJpeg } from "./heic-convert.service";
import {
  COLLAGE_TEXT_SIZES,
  MAX_COLLAGE_PHOTOS,
  MIN_COLLAGE_PHOTOS,
  collageLayouts,
  collageTakenAt,
  isTextPosition,
  pickCollageLayout,
  renderCollage,
  type CollageSource,
  type CollageText,
  type CollageTextPosition,
  type CollageTextSize,
} from "./collage";

export interface CreateCollageRequest {
  /** In cell order; 2 to 9. */
  photoIds: number[];
  /** A layout id for that many photos; the first variant when left out. */
  layout?: string;
  text?: string;
  textPosition?: CollageTextPosition;
  textSize?: CollageTextSize;
  /** `#rrggbb`, white when left out. */
  textColor?: string;
}

export interface CreateCollageResponse {
  photoId: number;
  filename: string;
  layout: string;
  /** False when the same collage was filed before; the earlier photo is returned. */
  created: boolean;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The caption of a request, or null without text; throws on a bad position, size or colour. */
export function captionOf(req: Pick<CreateCollageRequest, "text" | "textPosition" | "textSize" | "textColor">): CollageText | null {
  const text = req.text?.trim();
  if (!text) return null;
  const position = req.textPosition ?? "center";
  if (!isTextPosition(position)) throw APIError.invalidArgument(`unknown text position ${String(position)}`);
  const size = req.textSize ?? "medium";
  if (!(size in COLLAGE_TEXT_SIZES)) throw APIError.invalidArgument(`unknown text size ${String(size)}`);
  const color = req.textColor ?? "#ffffff";
  if (!HEX_COLOR.test(color)) throw APIError.invalidArgument("textColor must be #rrggbb");
  return { text, position, size, color };
}

export const createPhotoCollage = api(
  { expose: true, method: "POST", path: "/photos/collage", auth: true },
  async (req: CreateCollageRequest): Promise<CreateCollageResponse> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "module.photos");
    requirePermission(auth, "photos.upload");
    const userId = parseInt(auth.userID, 10);

    const ids = req.photoIds ?? [];
    if (ids.length < MIN_COLLAGE_PHOTOS || ids.length > MAX_COLLAGE_PHOTOS) {
      throw APIError.invalidArgument(`a collage takes ${MIN_COLLAGE_PHOTOS} to ${MAX_COLLAGE_PHOTOS} photos`);
    }
    if (new Set(ids).size !== ids.length) throw APIError.invalidArgument("a photo appears twice");
    const layout = pickCollageLayout(ids.length, req.layout);
    if (!layout) {
      const known = collageLayouts(ids.length).map((l) => l.id).join(", ");
      throw APIError.invalidArgument(`unknown layout ${req.layout} for ${ids.length} photos; one of ${known}`);
    }
    const caption = captionOf(req);
    for (const id of ids) await assertPhotoAccess(userId, id);

    const rows = await dbAll<{ id: number; filename: string; mime_type: string; auto_crop: { x: number; y: number } | null; taken_at: string | null }>(
      db.select({
        id: photos.id,
        filename: photos.filename,
        mime_type: photos.mime_type,
        auto_crop: photos.auto_crop,
        taken_at: photos.taken_at,
      }).from(photos).where(inArray(photos.id, ids)),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const sources: CollageSource[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) throw APIError.notFound("photo not found");
      if (!row.mime_type.startsWith("image/")) throw APIError.invalidArgument(`photo ${id} is not a picture`);
      const filePath = await resolvePhotoFilePath(row.filename);
      if (!filePath) throw APIError.failedPrecondition(`the file of photo ${id} is missing`);
      const ext = path.extname(filePath).toLowerCase();
      const input = ext === ".heic" || ext === ".heif" ? await convertHeicToJpeg(filePath) : filePath;
      sources.push({ input, focal: row.auto_crop });
    }

    const jpeg = await renderCollage(layout, sources, caption);
    const takenAt = collageTakenAt(rows.map((r) => r.taken_at));
    try {
      const photo = await uploadPhotoLogic(
        userId,
        { data: jpeg, name: `collage-${Date.now()}.jpg`, mimeType: "image/jpeg" },
        takenAt,
      );
      return { photoId: photo.id, filename: photo.filename, layout: layout.id, created: true };
    } catch (err) {
      if (!(err instanceof PhotoAlreadyExistsError)) throw err;
      const existing = await dbFirst<{ filename: string }>(
        db.select({ filename: photos.filename }).from(photos).where(eq(photos.id, err.existingPhotoId)),
      );
      if (!existing) throw err;
      return { photoId: err.existingPhotoId, filename: existing.filename, layout: layout.id, created: false };
    }
  },
);
