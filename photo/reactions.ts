/**
 * HTTP endpoints for photo reactions (likes + comments).
 *
 * Lives in the `photo` service so it shares auth, DB and realtime wiring
 * with the rest of the photo module. Access control is delegated to
 * reactions.service, which piggy-backs on `getUsersWithPhotoAccess`.
 */

import { api, APIError } from "encore.dev/api";
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

// ---------- Likes ----------

export const likePhoto = api(
  { expose: true, method: "POST", path: "/photos/:id/like", auth: true },
  async ({ id }: { id: number }): Promise<svc.PhotoLikeSummary> => {
    requirePhotosView();
    return await svc.likePhoto(getUserId(), id);
  },
);

export const unlikePhoto = api(
  { expose: true, method: "DELETE", path: "/photos/:id/like", auth: true },
  async ({ id }: { id: number }): Promise<svc.PhotoLikeSummary> => {
    requirePhotosView();
    return await svc.unlikePhoto(getUserId(), id);
  },
);

export const getLikeSummary = api(
  { expose: true, method: "GET", path: "/photos/:id/likes/summary", auth: true },
  async ({ id }: { id: number }): Promise<svc.PhotoLikeSummary> => {
    requirePhotosView();
    return await svc.getLikeSummary(getUserId(), id);
  },
);

export const listLikers = api(
  { expose: true, method: "GET", path: "/photos/:id/likes", auth: true },
  async ({ id }: { id: number }): Promise<{ likers: svc.PhotoLiker[] }> => {
    requirePhotosView();
    const likers = await svc.listLikers(getUserId(), id);
    return { likers };
  },
);

// ---------- Comments ----------

interface CreateCommentRequest {
  body: string;
}

export const listComments = api(
  { expose: true, method: "GET", path: "/photos/:id/comments", auth: true },
  async ({ id }: { id: number }): Promise<{ comments: svc.PhotoComment[] }> => {
    requirePhotosView();
    const comments = await svc.listComments(getUserId(), id);
    return { comments };
  },
);

export const createComment = api(
  { expose: true, method: "POST", path: "/photos/:id/comments", auth: true },
  async (
    { id, body }: CreateCommentRequest & { id: number },
  ): Promise<svc.PhotoComment> => {
    requirePhotosView();
    return await svc.createComment(getUserId(), id, body);
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
