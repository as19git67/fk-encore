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
import {
  albumPhotos,
  albumPublicLinks,
  guests,
  photoComments,
  photos,
  users,
} from "../db/schema";
import { feed, realtime, sharedalbum } from "~encore/clients";
import { getUsersWithPhotoAccess, emitFeedItem } from "./photo.service";

const MAX_COMMENT_LENGTH = 2000;

export type CommentAuthorKind = "user" | "guest";

export interface PhotoComment {
  id: number;
  photoId: number;
  author: {
    id: number;
    name: string | null;
    kind: CommentAuthorKind;
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

interface CommentRow {
  id: number;
  photo_id: number;
  user_id: number | null;
  guest_id: number | null;
  user_name: string | null;
  guest_name: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
}

function toPhotoComment(r: CommentRow): PhotoComment {
  if (r.guest_id !== null) {
    return {
      id: r.id,
      photoId: r.photo_id,
      author: { id: r.guest_id, name: r.guest_name, kind: "guest" },
      body: r.body,
      createdAt: r.created_at,
      editedAt: r.edited_at,
    };
  }
  return {
    id: r.id,
    photoId: r.photo_id,
    author: { id: r.user_id ?? 0, name: r.user_name, kind: "user" },
    body: r.body,
    createdAt: r.created_at,
    editedAt: r.edited_at,
  };
}

/**
 * Raw listing by photo id. Does no access check — callers must assert
 * access themselves (user audience check, or guest-link check).
 */
export async function fetchCommentsForPhoto(photoId: number): Promise<PhotoComment[]> {
  const rows = await dbAll<CommentRow>(
    db
      .select({
        id: photoComments.id,
        photo_id: photoComments.photo_id,
        user_id: photoComments.user_id,
        guest_id: photoComments.guest_id,
        user_name: users.name,
        guest_name: guests.display_name,
        body: photoComments.body,
        created_at: photoComments.created_at,
        edited_at: photoComments.edited_at,
      })
      .from(photoComments)
      .leftJoin(users, eq(users.id, photoComments.user_id))
      .leftJoin(guests, eq(guests.id, photoComments.guest_id))
      .where(eq(photoComments.photo_id, photoId))
      .orderBy(asc(photoComments.created_at), asc(photoComments.id)),
  );
  return rows.map(toPhotoComment);
}

export async function listComments(
  userId: number,
  photoId: number,
): Promise<PhotoComment[]> {
  await assertPhotoAccess(userId, photoId);
  return fetchCommentsForPhoto(photoId);
}

/**
 * Assert that the photo is reachable via the given public link (i.e.
 * it belongs to the album that link points to). Used by guest-facing
 * endpoints to authorize comment read/write without leaking info about
 * photos in other albums.
 */
export async function assertPhotoInPublicLink(
  photoId: number,
  publicLinkId: number,
): Promise<void> {
  const hit = await dbFirst<{ photo_id: number }>(
    db
      .select({ photo_id: albumPhotos.photo_id })
      .from(albumPhotos)
      .innerJoin(albumPublicLinks, eq(albumPublicLinks.album_id, albumPhotos.album_id))
      .where(and(eq(albumPhotos.photo_id, photoId), eq(albumPublicLinks.id, publicLinkId)))
      .limit(1),
  );
  if (!hit) throw APIError.notFound("photo not found");
}

/**
 * List comments on a photo via a public-link (guest) path. Access is
 * authorized by the caller-supplied publicLinkId, which resolveGuest
 * (sharedalbum) scopes to the guest's current session.
 */
export async function listCommentsForGuest(
  publicLinkId: number,
  photoId: number,
): Promise<PhotoComment[]> {
  await assertPhotoInPublicLink(photoId, publicLinkId);
  return fetchCommentsForPhoto(photoId);
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
  albumId?: number,
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
    author: { id: row.user_id, name: author?.name ?? null, kind: "user" },
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
    albumId,
    photoId,
    payload: {
      commentId: comment.id,
      // Short excerpt so the feed card can show a preview without
      // fetching the full comment.
      excerpt: comment.body.slice(0, 140),
    },
  });
  // Fan out to guests of the album whose view the comment was made
  // from. `albumId` is set when the comment originated from an album
  // detail page; without it (e.g. comment from a generic photo grid)
  // we still notify every public-link guest who can see the photo.
  await sharedalbum
    .fanoutPhoto({
      photoId,
      albumId,
      kind: "comment_added",
      payload: {
        commentId: comment.id,
        authorName: author?.name ?? null,
        excerpt: comment.body.slice(0, 140),
      },
    })
    .catch((err: unknown) => {
      console.warn(
        `[reactions] guest fanout failed photo=${photoId}: ${(err as Error).message}`,
      );
    });

  return comment;
}

/**
 * Guest version of createComment. The caller (sharedalbum service)
 * must have already authorized the guest session against the public
 * link — this function only checks that the photo actually belongs to
 * that link's album.
 *
 * Fan-out to the regular user audience (realtime + feed) happens here
 * with actor_user_id=NULL and a `guestName` in payload. Fan-out to
 * other guests is handled by the separate guest-notification pipeline
 * (see etappe 4).
 */
export async function createCommentAsGuest(
  guestId: number,
  photoId: number,
  rawBody: string,
  publicLinkId: number,
  albumId: number,
): Promise<PhotoComment> {
  await assertPhotoInPublicLink(photoId, publicLinkId);
  const body = normalizeCommentBody(rawBody);

  const inserted = await dbAll<{
    id: number;
    photo_id: number;
    guest_id: number | null;
    body: string;
    created_at: string;
    edited_at: string | null;
  }>(
    db
      .insert(photoComments)
      .values({ photo_id: photoId, guest_id: guestId, body })
      .returning({
        id: photoComments.id,
        photo_id: photoComments.photo_id,
        guest_id: photoComments.guest_id,
        body: photoComments.body,
        created_at: photoComments.created_at,
        edited_at: photoComments.edited_at,
      }),
  );
  const row = inserted[0];

  const guest = await dbFirst<{ display_name: string }>(
    db.select({ display_name: guests.display_name }).from(guests).where(eq(guests.id, guestId)),
  );
  const guestName = guest?.display_name ?? "Gast";

  const comment: PhotoComment = {
    id: row.id,
    photoId: row.photo_id,
    author: { id: guestId, name: guestName, kind: "guest" },
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };

  const audience = await getUsersWithPhotoAccess(photoId);
  await publishPhotoEvent(audience, "commented", photoId, {
    commentId: comment.id,
    guestId,
    guestName,
    body: comment.body,
  });
  try {
    await feed.emitFeed({
      recipients: audience,
      actorUserId: null,
      kind: "photo_commented",
      // Deep-link the household member's notification to the album the
      // guest commented from, so it opens the photo rather than the feed.
      albumId,
      photoId,
      payload: {
        commentId: comment.id,
        guestId,
        guestName,
        excerpt: comment.body.slice(0, 140),
      },
    });
  } catch (err) {
    console.warn(
      `[reactions] guest feed emit failed photo=${photoId}: ${(err as Error).message}`,
    );
  }
  // Notify only guests of the album whose share-link the author used —
  // a photo shared via several album links must not leak comments
  // across the audiences of those albums.
  await sharedalbum
    .fanoutPhoto({
      photoId,
      albumId,
      kind: "comment_added",
      excludeGuestId: guestId,
      payload: {
        commentId: comment.id,
        authorName: guestName,
        excerpt: comment.body.slice(0, 140),
      },
    })
    .catch((err: unknown) => {
      console.warn(
        `[reactions] guest-to-guest fanout failed photo=${photoId}: ${(err as Error).message}`,
      );
    });

  return comment;
}

async function getCommentForEdit(commentId: number): Promise<
  | { id: number; photo_id: number; user_id: number | null; guest_id: number | null }
  | undefined
> {
  return await dbFirst<{
    id: number;
    photo_id: number;
    user_id: number | null;
    guest_id: number | null;
  }>(
    db
      .select({
        id: photoComments.id,
        photo_id: photoComments.photo_id,
        user_id: photoComments.user_id,
        guest_id: photoComments.guest_id,
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
    user_id: number | null;
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
    author: { id: row.user_id ?? userId, name: author?.name ?? null, kind: "user" },
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

export async function updateCommentAsGuest(
  guestId: number,
  commentId: number,
  rawBody: string,
  publicLinkId: number,
): Promise<PhotoComment> {
  const existing = await getCommentForEdit(commentId);
  if (!existing) throw APIError.notFound("comment not found");
  if (existing.guest_id !== guestId) {
    throw APIError.permissionDenied("not the comment author");
  }
  await assertPhotoInPublicLink(existing.photo_id, publicLinkId);
  const body = normalizeCommentBody(rawBody);

  const updated = await dbAll<{
    id: number;
    photo_id: number;
    guest_id: number | null;
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
        guest_id: photoComments.guest_id,
        body: photoComments.body,
        created_at: photoComments.created_at,
        edited_at: photoComments.edited_at,
      }),
  );
  const row = updated[0];

  const guest = await dbFirst<{ display_name: string }>(
    db.select({ display_name: guests.display_name }).from(guests).where(eq(guests.id, guestId)),
  );

  const comment: PhotoComment = {
    id: row.id,
    photoId: row.photo_id,
    author: { id: guestId, name: guest?.display_name ?? null, kind: "guest" },
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };

  const audience = await getUsersWithPhotoAccess(existing.photo_id);
  await publishPhotoEvent(audience, "comment_updated", existing.photo_id, {
    commentId: comment.id,
    guestId,
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
  // moderate (delete) any comment on their photo — including guest
  // comments.
  let isAuthor = existing.user_id !== null && existing.user_id === userId;
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

export async function deleteCommentAsGuest(
  guestId: number,
  commentId: number,
  publicLinkId: number,
): Promise<{ success: boolean }> {
  const existing = await getCommentForEdit(commentId);
  if (!existing) throw APIError.notFound("comment not found");
  if (existing.guest_id !== guestId) {
    throw APIError.permissionDenied("not the comment author");
  }
  await assertPhotoInPublicLink(existing.photo_id, publicLinkId);

  await dbExec(db.delete(photoComments).where(eq(photoComments.id, commentId)));

  const audience = await getUsersWithPhotoAccess(existing.photo_id);
  await publishPhotoEvent(audience, "comment_deleted", existing.photo_id, {
    commentId,
    guestId,
  });

  return { success: true };
}
