// Guest Web Push: raw HTTP endpoints + send helper.
//
// Mirrors push/push.ts but authenticates via the guest session cookie
// instead of a bearer token, and writes to guest_push_subscriptions.
// VAPID configuration is shared with the user push service — the
// `web-push` module stores its VAPID keys in module-level state, so
// once push/push.service.ts has called configureVapid() for the first
// user-push send the same state applies here.

import { api, APIError } from "encore.dev/api";
import { and, eq } from "drizzle-orm";
import webPush from "web-push";
import db from "../db/database";
import { dbAll, dbExec } from "../db/adapter";
import { guestPushSubscriptions } from "../db/schema";
import { pushEnabled, getVapidPublicKey } from "../push/push.service";
import {
  parseJsonBody,
  readBody,
  writeError,
  writeJson,
} from "./http";
import { resolveGuest } from "./guests.service";

// ---------- Raw endpoints ----------

// GET /share/:token/guests/push/vapid-key
export const guestVapidKey = api.raw(
  {
    expose: true,
    method: "GET",
    path: "/share/:token/guests/push/vapid-key",
    auth: false,
  },
  async (req, res) => {
    try {
      // The endpoint is public — the VAPID *public* key is safe to
      // expose and the frontend needs it before the user even opts in
      // to notifications.
      writeJson(res, 200, {
        publicKey: getVapidPublicKey(),
        enabled: pushEnabled(),
      });
    } catch (err) {
      writeError(res, err);
    }
  },
);

// POST /share/:token/guests/push/subscribe
// Body: { endpoint, keys: { p256dh, auth }, userAgent? }
export const guestPushSubscribe = api.raw(
  {
    expose: true,
    method: "POST",
    path: "/share/:token/guests/push/subscribe",
    auth: false,
  },
  async (req, res) => {
    try {
      const token = extractToken(req.url, "/subscribe");
      const resolved = await resolveGuest(req, token);
      if (!resolved) throw APIError.unauthenticated("no guest session");
      if (!resolved.guest.verified_at) {
        throw APIError.permissionDenied("guest not verified");
      }
      if (!pushEnabled()) {
        throw APIError.failedPrecondition("push notifications not configured");
      }
      const body = parseJsonBody<{
        endpoint?: string;
        keys?: { p256dh?: string; auth?: string };
        userAgent?: string;
      }>(await readBody(req));
      if (
        !body?.endpoint ||
        !body.keys?.p256dh ||
        !body.keys?.auth
      ) {
        throw APIError.invalidArgument("missing endpoint/keys");
      }
      const result = await saveGuestSubscription(
        resolved.guest.id,
        { endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } },
        body.userAgent ?? null,
      );
      writeJson(res, 200, result);
    } catch (err) {
      writeError(res, err);
    }
  },
);

// POST /share/:token/guests/push/unsubscribe
// Body: { endpoint }
export const guestPushUnsubscribe = api.raw(
  {
    expose: true,
    method: "POST",
    path: "/share/:token/guests/push/unsubscribe",
    auth: false,
  },
  async (req, res) => {
    try {
      const token = extractToken(req.url, "/unsubscribe");
      const resolved = await resolveGuest(req, token);
      if (!resolved) throw APIError.unauthenticated("no guest session");
      const body = parseJsonBody<{ endpoint?: string }>(await readBody(req));
      if (!body?.endpoint) throw APIError.invalidArgument("missing endpoint");
      const result = await removeGuestSubscription(resolved.guest.id, body.endpoint);
      writeJson(res, 200, result);
    } catch (err) {
      writeError(res, err);
    }
  },
);

function extractToken(url: string | undefined, suffix: string): string {
  if (!url) throw APIError.invalidArgument("missing url");
  const pathname = url.split("?")[0];
  const prefix = "/share/";
  const segment = `/guests/push${suffix}`;
  if (!pathname.startsWith(prefix)) throw APIError.invalidArgument("bad path");
  const rest = pathname.slice(prefix.length);
  const idx = rest.indexOf(segment);
  if (idx < 0) throw APIError.invalidArgument("bad path");
  const token = rest.slice(0, idx);
  if (!token) throw APIError.invalidArgument("missing share token");
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

// ---------- Subscription management ----------

export interface GuestPushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export async function saveGuestSubscription(
  guestId: number,
  sub: GuestPushSubscriptionInput,
  userAgent: string | null,
): Promise<{ id: number }> {
  const rows = await dbAll<{ id: number }>(
    db
      .insert(guestPushSubscriptions)
      .values({
        guest_id: guestId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: userAgent,
      })
      .onConflictDoUpdate({
        target: guestPushSubscriptions.endpoint,
        set: {
          guest_id: guestId,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          user_agent: userAgent,
        },
      })
      .returning({ id: guestPushSubscriptions.id }),
  );
  return { id: rows[0]?.id ?? 0 };
}

export async function removeGuestSubscription(
  guestId: number,
  endpoint: string,
): Promise<{ removed: number }> {
  const { changes } = await dbExec(
    db
      .delete(guestPushSubscriptions)
      .where(
        and(
          eq(guestPushSubscriptions.guest_id, guestId),
          eq(guestPushSubscriptions.endpoint, endpoint),
        ),
      ),
  );
  return { removed: changes };
}

async function listGuestSubscriptions(
  guestId: number,
): Promise<Array<{ id: number; endpoint: string; p256dh: string; auth: string }>> {
  return await dbAll<{
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    db
      .select({
        id: guestPushSubscriptions.id,
        endpoint: guestPushSubscriptions.endpoint,
        p256dh: guestPushSubscriptions.p256dh,
        auth: guestPushSubscriptions.auth,
      })
      .from(guestPushSubscriptions)
      .where(eq(guestPushSubscriptions.guest_id, guestId)),
  );
}

async function deleteGuestSubscriptionById(id: number): Promise<void> {
  await dbExec(db.delete(guestPushSubscriptions).where(eq(guestPushSubscriptions.id, id)));
}

// ---------- Send ----------

export interface GuestPushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

/**
 * Deliver a notification to every Web Push subscription a guest has.
 * Errors are logged but never thrown — push is best-effort. Gone
 * endpoints (404/410) are pruned so we don't waste requests later.
 */
export async function sendToGuest(
  guestId: number,
  payload: GuestPushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!pushEnabled()) return { sent: 0, pruned: 0 };
  const subs = await listGuestSubscriptions(guestId);
  if (subs.length === 0) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webPush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
        sent += 1;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          await deleteGuestSubscriptionById(s.id).catch(() => undefined);
          pruned += 1;
        } else {
          console.warn(
            `[sharedalbum.push] send failed guest=${guestId} status=${status ?? "?"}: ${(err as Error).message}`,
          );
        }
      }
    }),
  );

  return { sent, pruned };
}

/**
 * Build a user-facing notification from a guest_notifications row.
 * Kept next to sendToGuest so all guest-push wording lives in one
 * place, mirroring push.service.buildFeedNotification for users.
 */
export function buildGuestNotification(input: {
  kind: "photo_added" | "comment_added";
  albumName: string;
  albumLinkToken: string;
  payload: Record<string, unknown>;
}): GuestPushPayload {
  const album = input.albumName;
  let title = "Neuigkeit";
  let body = "";
  if (input.kind === "photo_added") {
    const count = Array.isArray(input.payload.photoIds)
      ? (input.payload.photoIds as unknown[]).length
      : 0;
    title = "Neue Fotos";
    body =
      count > 1
        ? `${count} neue Fotos in „${album}"`
        : `Neues Foto in „${album}"`;
  } else {
    const actor =
      typeof input.payload.authorName === "string" ? input.payload.authorName : "Jemand";
    const excerpt =
      typeof input.payload.excerpt === "string" ? input.payload.excerpt : "";
    title = "Neuer Kommentar";
    body = excerpt ? `${actor}: ${excerpt}` : `${actor} hat kommentiert in „${album}"`;
  }
  const url = `/app/albums/shared/${encodeURIComponent(input.albumLinkToken)}`;
  return {
    title,
    body,
    url,
    tag: `${input.kind}:${input.albumLinkToken}`,
    data: { kind: input.kind, albumLinkToken: input.albumLinkToken },
  };
}
