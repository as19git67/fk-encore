/**
 * The critique of a photo in words (documentation/plans/foto-aesthetik.md,
 * stage 6): read the kept one, or ask Gemma for a new one. Anyone who may see
 * the photo may do both; the text describes the picture, not its owner.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { assertPhotoAccess } from "./photo-file-access";
import { CritiqueUnavailableError, loadCritique, requestCritique, type PhotoCritique } from "./critique";

function viewer(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "module.photos");
  return parseInt(auth.userID);
}

export const getPhotoCritique = api(
  { expose: true, method: "GET", path: "/photos/:id/critique", auth: true },
  async ({ id }: { id: number }): Promise<{ critique: PhotoCritique | null }> => {
    await assertPhotoAccess(viewer(), id);
    return { critique: await loadCritique(id) };
  },
);

export const createPhotoCritique = api(
  { expose: true, method: "POST", path: "/photos/:id/critique", auth: true },
  async ({ id, refresh }: { id: number; refresh?: boolean }): Promise<{ critique: PhotoCritique }> => {
    await assertPhotoAccess(viewer(), id);
    if (!refresh) {
      const kept = await loadCritique(id);
      if (kept) return { critique: kept };
    }
    try {
      return { critique: await requestCritique(id) };
    } catch (err) {
      if (!(err instanceof CritiqueUnavailableError)) throw err;
      if (err.reason === "gpu_lent" || err.reason === "no_vision" || err.reason === "no_image") {
        throw APIError.failedPrecondition(err.message);
      }
      throw APIError.unavailable(err.message);
    }
  },
);
