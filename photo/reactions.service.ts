/**
 * Photo comments.
 *
 * Audience rules mirror photo access: anyone who can see the photo
 * (owner + users with album access via `getUsersWithPhotoAccess`) can
 * comment. Each new comment fans out a realtime `photos/…` event and a
 * feed entry to the full audience minus the actor.
 *
 * The former "Like" feature has been consolidated into the existing
 * Favorite curation flow — `updatePhotoCurationLogic` emits the
 * equivalent `photo_favorited` feed event when a user favourites a
 * photo in a shared album.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import { photoComments, photos, users } from "../db/schema";
import { realtime } from "~encore/clients";
import { getUsersWithPhotoAccess, emitFeedItem } from "./photo.service";

const MAX_COMMENT_LENGTH = 2000;

export interface PhotoComment {
  id: number;
  photoId: number;
  author: {
    id: number;
    name: string | null;
  };
  body: string;
  createdAt: string;
  editedAt: string | null;
}

async function assertPhotoAccess(
  userId: number,
  photoId: number,
): Promise<number[]> {
  const photo = await dbFirst<{ id: number }>(
    db.select({ id: photos.id }).from(photos).where(eq(photos.id, photoId)),
  );
  if (!photo) throw APIError.notFound("photo not found");

  const audience = await getUsersWithPhotoAccess(photoId);
  if (!audience.includes(userId)) {
    // Same response as "doesn't exist" so we don't leak IDs.
    throw APIError.notFound("photo not found");
  }
  return audience;
}

async function publishPhotoEvent(
  userIds: number[],
  type: string,
  photoId: number,
  payload: Record<string, unknown>,
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await realtime.publishEvent({
      userIds: userIds.map((id) => String(id)),
      channel: "photos",
      type,
      resourceId: String(photoId),
      payload,
    });
  } catch (err) {
    console.warn(
      `[reactions] realtime publish failed photo=${photoId} type=${type}: ${(err as Error).message}`,
    );
  }
}

function recipientsExcludingActor(audience: number[], actorUserId: number): number[] {
  return audience.filter((uid) => uid !== actorUserId);
}

export async function listComments(
  userId: number,
  photoId: number,
): Promise<PhotoComment[]> {
  await assertPhotoAccess(userId, photoId);

  const rows = await dbAll<{
    id: number;
    photo_id: number;
    user_id: number;
    author_name: string | null;
    body: string;
    created_at: string;
    edited_at: string | null;
  }>(
    db
      .select({
        id: photoComments.id,
        photo_id: photoComments.photo_id,
        user_id: photoComments.user_id,
        author_name: users.name,
        body: photoComments.body,
        created_at: photoComments.created_at,
        edited_at: photoComments.edited_at,
      })
      .from(photoComments)
      .leftJoin(users, eq(users.id, photoComments.user_id))
      .where(eq(photoComments.photo_id, photoId))
      .orderBy(asc(photoComments.created_at), asc(photoComments.id)),
  );
  return rows.map((r) => ({
    id: r.id,
    photoId: r.photo_id,
    author: { id: r.user_id, name: r.author_name },
    body: r.body,
    createdAt: r.created_at,
    editedAt: r.edited_at,
  }));
}

function normalizeCommentBody(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    throw APIError.invalidArgument("comment body must not be empty");
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw APIError.invalidArgument(
      `comment body exceeds ${MAX_COMMENT_LENGTH} characters`,
    );
  }
  return trimmed;
}

export async function createComment(
  userId: number,
  photoId: number,
  rawBody: string,
): Promise<PhotoComment> {
  const audience = await assertPhotoAccess(userId, photoId);
  const body = normalizeCommentBody(rawBody);

  const inserted = await dbAll<{
    id: number;
    photo_id: number;
    user_id: number;
    body: string;
    created_at: string;
    edited_at: string | null;
  }>(
    db
      .insert(photoComments)
      .values({ photo_id: photoId, user_id: userId, body })
      .returning({
        id: photoComments.id,
        photo_id: photoComments.photo_id,
        user_id: photoComments.user_id,
        body: photoComments.body,
        created_at: photoComments.created_at,
        edited_at: photoComments.edited_at,
      }),
  );
  const row = inserted[0];

  // Look up the author name once so the realtime event carries enough
  // context for open photo views to render the new comment without
  // round-tripping.
  const author = await dbFirst<{ name: string | null }>(
    db.select({ name: users.name }).from(users).where(eq(users.id, userId)),
  );
  const comment: PhotoComment = {
    id: row.id,
    photoId: row.photo_id,
    author: { id: row.user_id, name: author?.name ?? null },
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };

  const recipients = recipientsExcludingActor(audience, userId);
  await publishPhotoEvent(recipients, "commented", photoId, {
    commentId: comment.id,
    userId,
    body: comment.body,
  });
  await emitFeedItem(recipients, userId, "photo_commented", {
    photoId,
    payload: {
      commentId: comment.id,
      // Short excerpt so the feed card can show a preview without
      // fetching the full comment.
      excerpt: comment.body.slice(0, 140),
    },
  });

  return comment;
}

async function getCommentForEdit(commentId: number): Promise<
  | { id: number; photo_id: number; user_id: number }
  | undefined
> {
  return await dbFirst<{ id: number; photo_id: number; user_id: number }>(
    db
      .select({
        id: photoComments.id,
        photo_id: photoComments.photo_id,
        user_id: photoComments.user_id,
      })
      .from(photoComments)
      .where(eq(photoComments.id, commentId)),
  );
}

export async function updateComment(
  userId: number,
  commentId: number,
  rawBody: string,
): Promise<PhotoComment> {
  const existing = await getCommentForEdit(commentId);
  if (!existing) throw APIError.notFound("comment not found");
  if (existing.user_id !== userId) {
    throw APIError.permissionDenied("not the comment author");
  }
  const body = normalizeCommentBody(rawBody);

  const updated = await dbAll<{
    id: number;
    photo_id: number;
    user_id: number;
    body: string;
    created_at: string;
    edited_at: string | null;
  }>(
    db
      .update(photoComments)
      .set({ body, edited_at: sql`NOW()` })
      .where(eq(photoComments.id, commentId))
      .returning({
        id: photoComments.id,
        photo_id: photoComments.photo_id,
        user_id: photoComments.user_id,
        body: photoComments.body,
        created_at: photoComments.created_at,
        edited_at: photoComments.edited_at,
      }),
  );
  const row = updated[0];

  const author = await dbFirst<{ name: string | null }>(
    db.select({ name: users.name }).from(users).where(eq(users.id, userId)),
  );
  const comment: PhotoComment = {
    id: row.id,
    photoId: row.photo_id,
    author: { id: row.user_id, name: author?.name ?? null },
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };

  const audience = await getUsersWithPhotoAccess(existing.photo_id);
  const recipients = recipientsExcludingActor(audience, userId);
  await publishPhotoEvent(recipients, "comment_updated", existing.photo_id, {
    commentId: comment.id,
    userId,
    body: comment.body,
  });

  return comment;
}

export async function deleteComment(
  userId: number,
  commentId: number,
): Promise<{ success: boolean }> {
  const existing = await getCommentForEdit(commentId);
  if (!existing) throw APIError.notFound("comment not found");

  // Author may always delete their own comment. The photo owner may
  // moderate (delete) any comment on their photo.
  let isAuthor = existing.user_id === userId;
  let isPhotoOwner = false;
  if (!isAuthor) {
    const owner = await dbFirst<{ user_id: number }>(
      db
        .select({ user_id: photos.user_id })
        .from(photos)
        .where(eq(photos.id, existing.photo_id)),
    );
    isPhotoOwner = owner?.user_id === userId;
  }
  if (!isAuthor && !isPhotoOwner) {
    throw APIError.permissionDenied("not allowed to delete this comment");
  }

  await dbExec(db.delete(photoComments).where(eq(photoComments.id, commentId)));

  const audience = await getUsersWithPhotoAccess(existing.photo_id);
  const recipients = recipientsExcludingActor(audience, userId);
  await publishPhotoEvent(recipients, "comment_deleted", existing.photo_id, {
    commentId,
    userId,
  });

  return { success: true };
}
