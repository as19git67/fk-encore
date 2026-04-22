/**
 * Web Push — HTTP endpoints.
 *
 * Public endpoints:
 *   GET  /push/vapid-public-key   → VAPID public key (base64url).
 *   POST /push/subscribe          → register a browser subscription.
 *   POST /push/unsubscribe        → remove a browser subscription.
 *
 * Internal endpoints (expose: false) invoked via ~encore/clients:
 *   fanoutFeed                    → send a feed notification to a user.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as svc from "./push.service";
import type { FeedItemKind } from "../feed/feed.service";

function requireUserId(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  // `photos.view` is the same gate the feed uses — push is a feed
  // delivery channel so the same permission applies.
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

// ---------- Public ----------

interface VapidKeyResponse {
  publicKey: string | null;
  enabled: boolean;
}

export const vapidPublicKey = api(
  { expose: true, method: "GET", path: "/push/vapid-public-key", auth: true },
  async (): Promise<VapidKeyResponse> => {
    requireUserId();
    return {
      publicKey: svc.getVapidPublicKey(),
      enabled: svc.pushEnabled(),
    };
  },
);

interface SubscribeRequest {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
}

interface SubscribeResponse {
  id: number;
}

export const subscribe = api(
  { expose: true, method: "POST", path: "/push/subscribe", auth: true },
  async (req: SubscribeRequest): Promise<SubscribeResponse> => {
    const userId = requireUserId();
    if (!svc.pushEnabled()) {
      throw APIError.failedPrecondition("push notifications not configured");
    }
    return await svc.saveSubscription(
      userId,
      { endpoint: req.endpoint, keys: req.keys },
      req.userAgent ?? null,
    );
  },
);

interface UnsubscribeRequest {
  endpoint: string;
}

export const unsubscribe = api(
  { expose: true, method: "POST", path: "/push/unsubscribe", auth: true },
  async (req: UnsubscribeRequest): Promise<{ removed: number }> => {
    const userId = requireUserId();
    return await svc.removeSubscription(userId, req.endpoint);
  },
);

// ---------- Internal ----------

interface FanoutFeedRequest {
  userId: number;
  kind: FeedItemKind;
  actorName: string | null;
  albumName: string | null;
  albumId: number | null;
  photoId: number | null;
  payload: Record<string, unknown>;
}

interface FanoutFeedResponse {
  sent: number;
  pruned: number;
}

/**
 * Called by `feed.service` after it fans out a feed_items row. The
 * feed already does dedup/filtering of the recipient list, so we
 * trust it here and just deliver. Errors are swallowed by the caller
 * — push must never break the primary write.
 */
export const fanoutFeed = api(
  { expose: false },
  async (req: FanoutFeedRequest): Promise<FanoutFeedResponse> => {
    const notification = svc.buildFeedNotification({
      kind: req.kind,
      actorName: req.actorName,
      albumName: req.albumName,
      albumId: req.albumId,
      photoId: req.photoId,
      payload: req.payload,
    });
    return await svc.sendToUser(req.userId, notification);
  },
);
