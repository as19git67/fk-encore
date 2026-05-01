/**
 * Web Push — HTTP endpoints.
 *
 * Public endpoints:
 *   GET  /push/vapid-public-key   → VAPID public key (base64url).
 *   POST /push/subscribe          → register a browser subscription.
 *   POST /push/unsubscribe        → remove a browser subscription.
 *   GET  /push/preferences        → get per-type notification preferences.
 *   PUT  /push/preferences        → update per-type notification preferences.
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

// ---------- Notification preferences ----------

interface NotificationPrefsResponse {
  preferences: svc.NotificationPrefs;
}

export const getPreferences = api(
  { expose: true, method: "GET", path: "/push/preferences", auth: true },
  async (): Promise<NotificationPrefsResponse> => {
    const userId = requireUserId();
    const preferences = await svc.getNotificationPrefs(userId);
    return { preferences };
  },
);

interface UpdatePreferencesRequest {
  preferences: svc.NotificationPrefs;
}

export const updatePreferences = api(
  { expose: true, method: "PUT", path: "/push/preferences", auth: true },
  async (req: UpdatePreferencesRequest): Promise<NotificationPrefsResponse> => {
    const userId = requireUserId();
    await svc.setNotificationPrefs(userId, req.preferences);
    return { preferences: req.preferences };
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
    // Respect per-user notification preferences: skip send if the user
    // has explicitly disabled this notification kind.
    const prefs = await svc.getNotificationPrefs(req.userId);
    if (!svc.isKindEnabled(prefs, req.kind as svc.NotificationKind)) {
      return { sent: 0, pruned: 0 };
    }
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

interface NotifyDocumentReviewRequest {
  userId: number;
  kind: svc.DocumentReviewKind;
  documentId: number;
  documentTitle: string | null;
  reason: string | null;
}

/**
 * Called by `documents/document-ops.ts` when a document needs human
 * attention — either the classifier returned low confidence or the
 * pipeline failed. Best-effort delivery, errors are swallowed.
 */
export const notifyDocumentReview = api(
  { expose: false },
  async (req: NotifyDocumentReviewRequest): Promise<FanoutFeedResponse> => {
    // Respect per-user notification preferences. The DocumentReviewKind
    // values map to dedicated prefs keys so they can be toggled
    // independently of the album/photo feed kinds.
    const prefs = await svc.getNotificationPrefs(req.userId);
    const prefsKind: svc.NotificationKind =
      req.kind === "low_confidence" ? "document_low_confidence" : "document_failed";
    if (!svc.isKindEnabled(prefs, prefsKind)) {
      return { sent: 0, pruned: 0 };
    }
    const notification = svc.buildDocumentNotification({
      kind: req.kind,
      documentId: req.documentId,
      documentTitle: req.documentTitle,
      reason: req.reason,
    });
    return await svc.sendToUser(req.userId, notification);
  },
);
