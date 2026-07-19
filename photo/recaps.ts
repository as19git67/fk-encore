/**
 * Rueckblicke (recaps) — API-Endpoints.
 *
 * Exponiert die in `recaps.service.ts` definierte Business-Logik als REST.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as recapsService from "./recaps.service";
import type { RecapSummary, RecapDetails } from "./recaps.service";
import {
  listMusicTracks,
  pickTrackForRecap,
  type MusicTrack,
} from "./recaps-music.service";

function getUserId(): number {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  return parseInt(authData.userID);
}

function checkModule() {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  requirePermission(authData, "module.photos");
}

interface ListRecapsResponse {
  recaps: RecapSummary[];
}

interface GetRecapResponse {
  recap: RecapDetails;
  /**
   * Suggested background track for the player, deterministically chosen from
   * the self-hosted music folder (same recap → same track). Absent when the
   * folder holds no usable audio files.
   */
  music?: MusicTrack;
}

interface DismissResponse {
  dismissed: boolean;
}

interface MarkSeenResponse {
  seen: boolean;
}

interface RebuildResponse {
  users?: number;
  on_this_day: number;
  trip: number;
}

interface ExcludePhotoResponse {
  /** The removed photo id. */
  removed: number;
  /** Backfilled replacement photo id, or null when the reserve was empty. */
  added: number | null;
  /** New ordered photo ids for the recap. */
  photo_ids: number[];
  cover_photo_id: number | null;
}

/**
 * List all visible (non-dismissed) recaps for the current user, sorted by
 * relevance.
 */
export const listRecaps = api(
  { expose: true, method: "GET", path: "/recaps", auth: true },
  async (): Promise<ListRecapsResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    const recaps = await recapsService.listRecapsForUser(userId, false);
    return { recaps };
  }
);

/**
 * Fetch a single recap with its ordered photo IDs. The frontend pulls photo
 * metadata via the standard /photos/details batch endpoint.
 */
export const getRecap = api(
  { expose: true, method: "GET", path: "/recaps/:id", auth: true },
  async ({ id }: { id: number }): Promise<GetRecapResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    const recap = await recapsService.getRecapForUser(userId, id);
    if (!recap) throw APIError.notFound("recap not found");
    const tracks = await listMusicTracks();
    const music = pickTrackForRecap(tracks, recap.kind, recap.id);
    return { recap, ...(music ? { music } : {}) };
  }
);

/**
 * Dismiss a recap so it disappears from the feed. Dismissed recaps are kept
 * in the DB so that subsequent rebuilds do not resurface the same memory.
 */
export const dismissRecap = api(
  { expose: true, method: "POST", path: "/recaps/:id/dismiss", auth: true },
  async ({ id }: { id: number }): Promise<DismissResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    const ok = await recapsService.dismissRecap(userId, id);
    if (!ok) throw APIError.notFound("recap not found");
    return { dismissed: true };
  }
);

/**
 * Mark a recap as seen so the UI can drop the "neu"-badge and the list
 * sort can move it out of the unseen bucket.
 */
export const markRecapSeen = api(
  { expose: true, method: "POST", path: "/recaps/:id/seen", auth: true },
  async ({ id }: { id: number }): Promise<MarkSeenResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    const ok = await recapsService.markRecapSeen(userId, id);
    if (!ok) throw APIError.notFound("recap not found");
    return { seen: true };
  }
);

/**
 * Exclude a single photo from a recap (from the collage view or the player).
 * The exclusion is persistent and the freed slot is backfilled with the
 * next-best reserve photo. Returns the recap's new photo membership.
 */
export const excludeRecapPhoto = api(
  { expose: true, method: "POST", path: "/recaps/:id/photos/:photoId/exclude", auth: true },
  async ({
    id,
    photoId,
  }: {
    id: number;
    photoId: number;
  }): Promise<ExcludePhotoResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    const result = await recapsService.excludeRecapPhoto(userId, id, photoId);
    if (result.status === "not_found") throw APIError.notFound("recap not found");
    if (result.status === "would_empty") {
      throw APIError.failedPrecondition(
        "cannot remove the last photo of a recap"
      );
    }
    return {
      removed: result.removed,
      added: result.added,
      photo_ids: result.photo_ids,
      cover_photo_id: result.cover_photo_id,
    };
  }
);

/**
 * Manually trigger a rebuild for the current user. Useful during development
 * and for an "Aktualisieren"-button in the UI.
 */
export const rebuildRecaps = api(
  { expose: true, method: "POST", path: "/recaps/rebuild", auth: true },
  async (): Promise<RebuildResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    const result = await recapsService.rebuildRecapsForUser(userId);
    return { on_this_day: result.on_this_day, trip: result.trip };
  }
);

/**
 * Internal endpoint — invoked by the daily cron job. Rebuilds recaps for all
 * users who own photos.
 */
export const rebuildRecapsInternal = api(
  { expose: false, method: "POST", path: "/internal/recaps/rebuild" },
  async (): Promise<RebuildResponse> => {
    const result = await recapsService.rebuildRecapsForAllUsers();
    return {
      users: result.users,
      on_this_day: result.total.on_this_day,
      trip: result.total.trip,
    };
  }
);
