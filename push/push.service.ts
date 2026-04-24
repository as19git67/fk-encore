/**
 * Web Push business logic.
 *
 * - Stores browser push subscriptions (endpoint + VAPID keys) per user.
 * - Sends notifications to all subscriptions of a user, pruning any
 *   endpoint the browser rejects with 404/410 (= permanently gone).
 *
 * VAPID keys live in Encore secrets so the private key never touches
 * source. Callers that just want to know whether push is usable can
 * check `pushEnabled()` — if the secrets are missing, every send is a
 * no-op and subscribe endpoints reject with FailedPrecondition.
 */

import webPush from "web-push";
import { and, eq } from "drizzle-orm";
import { secret } from "encore.dev/config";
import db from "../db/database";
import { dbAll, dbExec } from "../db/adapter";
import { pushSubscriptions } from "../db/schema";

// ---------- VAPID ----------

const vapidPublicKey = secret("VapidPublicKey");
const vapidPrivateKey = secret("VapidPrivateKey");
// RFC 8292 "sub": a URL or mailto: that identifies the server operator.
// Used by push services for abuse reporting.
const vapidSubject = secret("VapidSubject");

let vapidConfigured = false;
function configureVapid(): boolean {
  if (vapidConfigured) return true;
  let pub = "";
  let priv = "";
  let sub = "";
  try {
    pub = vapidPublicKey();
    priv = vapidPrivateKey();
    sub = vapidSubject();
  } catch {
    return false;
  }
  if (!pub || !priv || !sub) return false;
  webPush.setVapidDetails(sub, pub, priv);
  vapidConfigured = true;
  return true;
}

export function pushEnabled(): boolean {
  return configureVapid();
}

export function getVapidPublicKey(): string | null {
  try {
    const key = vapidPublicKey();
    return key || null;
  } catch {
    return null;
  }
}

// ---------- Subscription management ----------

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export async function saveSubscription(
  userId: number,
  sub: PushSubscriptionInput,
  userAgent: string | null,
): Promise<{ id: number }> {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error("invalid push subscription payload");
  }

  // ON CONFLICT (endpoint): a given browser returns the same endpoint
  // URL on every call, so we upsert to refresh keys + rebind to the
  // current user. This covers "user B logs in on the same device user
  // A was using".
  const rows = await dbAll<{ id: number }>(
    db
      .insert(pushSubscriptions)
      .values({
        user_id: userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: userAgent ?? null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          user_id: userId,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          user_agent: userAgent ?? null,
        },
      })
      .returning({ id: pushSubscriptions.id }),
  );
  return { id: rows[0]?.id ?? 0 };
}

export async function removeSubscription(
  userId: number,
  endpoint: string,
): Promise<{ removed: number }> {
  const { changes } = await dbExec(
    db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.user_id, userId),
          eq(pushSubscriptions.endpoint, endpoint),
        ),
      ),
  );
  return { removed: changes };
}

export async function listUserSubscriptions(userId: number): Promise<
  Array<{ id: number; endpoint: string; p256dh: string; auth: string }>
> {
  return await dbAll<{
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.user_id, userId)),
  );
}

async function deleteSubscriptionById(id: number): Promise<void> {
  await dbExec(
    db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)),
  );
}

// ---------- Send ----------

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

/**
 * Send a notification to every subscription belonging to a user.
 * Errors are logged but never thrown — push is best-effort. Gone
 * endpoints (404/410) are pruned so we don't waste requests later.
 */
export async function sendToUser(
  userId: number,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!configureVapid()) return { sent: 0, pruned: 0 };

  const subs = await listUserSubscriptions(userId);
  if (subs.length === 0) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          body,
        );
        sent += 1;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          // Subscription is permanently dead — remove it.
          await deleteSubscriptionById(s.id).catch(() => undefined);
          pruned += 1;
        } else {
          console.warn(
            `[push] send failed user=${userId} status=${status ?? "?"}: ${(err as Error).message}`,
          );
        }
      }
    }),
  );

  return { sent, pruned };
}

// ---------- Feed-event helpers ----------

import type { FeedItemKind } from "../feed/feed.service";

/**
 * Map a feed item to a short notification. Keeps the wording in one
 * place so `feed.service` doesn't need to know about push.
 */
export function buildFeedNotification(input: {
  kind: FeedItemKind;
  actorName: string | null;
  albumName: string | null;
  albumId: number | null;
  photoId: number | null;
  payload: Record<string, unknown>;
}): PushPayload {
  const actor = input.actorName ?? "Jemand";
  const album = input.albumName ?? "einem Album";

  let title = "Vivanty";
  let body = "";
  switch (input.kind) {
    case "photo_added":
      title = "Neues Foto";
      body = `${actor} hat ein Foto zu „${album}" hinzugefügt`;
      break;
    case "album_shared":
      title = "Album geteilt";
      body = `${actor} hat das Album „${album}" mit dir geteilt`;
      break;
    case "photo_favorited":
      title = "Neuer Favorit";
      body = `${actor} hat ein Foto favorisiert`;
      break;
    case "photo_commented": {
      const excerpt =
        typeof input.payload?.excerpt === "string"
          ? String(input.payload.excerpt)
          : "";
      title = "Neuer Kommentar";
      body = excerpt
        ? `${actor}: ${excerpt}`
        : `${actor} hat ein Foto kommentiert`;
      break;
    }
    case "album_left":
      title = "Freigabe verlassen";
      body = `${actor} hat die Freigabe von „${album}" verlassen`;
      break;
  }

  // Deep-link into the album (optionally with a photo anchor) so
  // clicking the notification lands on the right page. URLs are
  // prefixed with `/app/` because the SPA is mounted there (see
  // web/static.ts + frontend/vite.config.ts `base`); bare `/fotos/...`
  // would fall through to the API router.
  let url = "/app/fotos/feed";
  if (input.albumId) {
    url = `/app/fotos/alben/${input.albumId}`;
    if (input.photoId) url += `?photoId=${input.photoId}`;
  }

  // `tag` collapses duplicate notifications (repeated likes on the
  // same photo from the same actor won't stack).
  const tag = `${input.kind}:${input.albumId ?? "-"}:${input.photoId ?? "-"}`;

  return {
    title,
    body,
    url,
    tag,
    data: {
      kind: input.kind,
      albumId: input.albumId,
      photoId: input.photoId,
    },
  };
}

// ---------- Document-event helpers ----------

export type DocumentReviewKind = "low_confidence" | "failed";

/**
 * Build a notification telling the uploader that one of their documents
 * needs a human look. Two flavors:
 *   - low_confidence: classification ran but the model wasn't sure.
 *   - failed: the pipeline gave up; the reason is the worker error.
 *
 * The deep link points at the document detail view so a single tap
 * opens the page where the user can re-classify or correct fields.
 */
export function buildDocumentNotification(input: {
  kind: DocumentReviewKind;
  documentId: number;
  documentTitle: string | null;
  reason: string | null;
}): PushPayload {
  const docLabel = input.documentTitle?.trim()
    ? `„${input.documentTitle.trim()}"`
    : `Dokument #${input.documentId}`;

  let title: string;
  let body: string;
  switch (input.kind) {
    case "low_confidence":
      title = "Dokument bitte prüfen";
      body = `${docLabel} wurde mit niedriger Konfidenz klassifiziert.`;
      break;
    case "failed":
      title = "Dokument fehlgeschlagen";
      body = input.reason
        ? `${docLabel}: ${input.reason}`
        : `${docLabel} konnte nicht verarbeitet werden.`;
      break;
  }

  return {
    title,
    body,
    url: `/app/dokumente/${input.documentId}`,
    // Collapse repeated notifications for the same document.
    tag: `document-review:${input.documentId}`,
    data: {
      kind: input.kind,
      documentId: input.documentId,
    },
  };
}
