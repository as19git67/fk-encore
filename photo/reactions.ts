/**
 * HTTP endpoints for photo comments.
 *
 * Lives in the `photo` service so it shares auth, DB and realtime wiring
 * with the rest of the photo module. Access control is delegated to
 * reactions.service, which piggy-backs on `getUsersWithPhotoAccess`.
 *
 * Likes were rolled into the Favorite curation flow; the former
 * `/photos/:id/like*` endpoints are gone. Use the existing
 * `/photos/:id/curation` endpoint with `status=favorite` instead.
 */

import { api, APIError, Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as svc from "./reactions.service";

function getUserId(): number {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  return parseInt(authData.userID);
}

function requirePhotosView() {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  requirePermission(authData, "photos.view");
}

// ---------- Comments ----------

interface CreateCommentRequest {
  body: string;
  /**
   * Album the comment is written in. Comments are album-scoped: the
   * same photo can live in several albums, and a comment is only
   * visible (and only fans out) within the album it was authored in.
   */
  albumId: number;
}

export const listComments = api(
  { expose: true, method: "GET", path: "/photos/:id/comments", auth: true },
  async (
    { id, albumId }: { id: number; albumId: Query<number> },
  ): Promise<{ comments: svc.PhotoComment[] }> => {
    requirePhotosView();
    const comments = await svc.listComments(getUserId(), id, albumId);
    return { comments };
  },
);

export const createComment = api(
  { expose: true, method: "POST", path: "/photos/:id/comments", auth: true },
  async (
    { id, body, albumId }: CreateCommentRequest & { id: number },
  ): Promise<svc.PhotoComment> => {
    requirePhotosView();
    return await svc.createComment(getUserId(), id, body, albumId);
  },
);

export const updateComment = api(
  { expose: true, method: "PATCH", path: "/photos/comments/:commentId", auth: true },
  async (
    { commentId, body }: CreateCommentRequest & { commentId: number },
  ): Promise<svc.PhotoComment> => {
    requirePhotosView();
    return await svc.updateComment(getUserId(), commentId, body);
  },
);

export const deleteComment = api(
  { expose: true, method: "DELETE", path: "/photos/comments/:commentId", auth: true },
  async ({ commentId }: { commentId: number }): Promise<{ success: boolean }> => {
    requirePhotosView();
    return await svc.deleteComment(getUserId(), commentId);
  },
);
