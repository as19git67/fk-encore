/**
 * Social feed — HTTP endpoints.
 *
 * The feed reuses the `photos.view` permission because every feed
 * entry refers to an album or a photo the user already has access
 * to. No separate feed.view permission is needed yet.
 */

import { api, APIError, Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as feedService from "./feed.service";
import type { FeedItem } from "./feed.service";

function requireUserId(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

interface ListFeedResponse {
  items: FeedItem[];
  nextCursor: number | null;
  unreadCount: number;
}

/**
 * Paginated timeline for the current user. Items are ordered newest
 * first. Pass `cursor` from a previous response to load the next
 * page; a null `nextCursor` marks the end of history.
 */
export const listFeed = api(
  { expose: true, method: "GET", path: "/feed", auth: true },
  async (
    { cursor, limit }: { cursor?: Query<number>; limit?: Query<number> },
  ): Promise<ListFeedResponse> => {
    const userId = requireUserId();
    return feedService.listFeedForUser(userId, { cursor, limit });
  },
);

interface UnreadCountResponse {
  count: number;
}

/**
 * Lightweight endpoint for the menu badge. Runs a partial-index scan
 * (`idx_feed_items_user_unseen`) so it stays cheap even as the feed
 * grows indefinitely.
 */
export const feedUnreadCount = api(
  { expose: true, method: "GET", path: "/feed/unread-count", auth: true },
  async (): Promise<UnreadCountResponse> => {
    const userId = requireUserId();
    const count = await feedService.countUnread(userId);
    return { count };
  },
);

interface MarkSeenRequest {
  upToId: number;
}

interface MarkSeenResponse {
  updated: number;
}

/**
 * Mark every feed item with id <= `upToId` as seen for the current
 * user. Idempotent.
 */
export const markFeedSeen = api(
  { expose: true, method: "POST", path: "/feed/mark-seen", auth: true },
  async (req: MarkSeenRequest): Promise<MarkSeenResponse> => {
    const userId = requireUserId();
    return feedService.markSeenForUser(userId, req);
  },
);

interface EmitFeedRequest {
  recipients: number[];
  actorUserId: number;
  kind: "photo_added" | "album_shared" | "photo_liked" | "photo_commented";
  albumId?: number | null;
  photoId?: number | null;
  payload?: Record<string, unknown>;
}

/**
 * Internal fan-out endpoint called by other services (photo,
 * reactions) via `~encore/clients`. Not exposed to the public
 * gateway: the caller owns the decision about who should receive the
 * feed item.
 */
export const emitFeed = api(
  { expose: false },
  async (req: EmitFeedRequest): Promise<void> => {
    await feedService.emitFeedItems(req);
  },
);
