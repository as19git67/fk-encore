/**
 * What goes over the wire to Apple for one notification (#765), and how a
 * device token is read. Pure, so the shape is testable.
 *
 * The same `PushPayload` the web leg sends is turned into an `aps`
 * dictionary plus the custom keys the iOS app reads:
 * - `url` — the deep link a tap opens, the web-relative path as
 *   `buildFeedNotification` writes it (`/app/fotos/alben/12?photoId=34`).
 *   The app resolves it against its configured server and routes it
 *   through `AppDeepLink`, so the server never needs to know its own
 *   origin.
 * - `data` — forwarded verbatim (kind, album id, photo id).
 *
 * `thread-id` groups notifications the way the web's `tag` collapses them,
 * and `apns-collapse-id` (a header, not payload) replaces an unread one
 * with the same tag instead of stacking a second.
 */

import type { PushPayload } from "./push.service";

export type ApnsEnvironment = "production" | "sandbox";

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** Apple caps a notification at 4 KB; the alert text is what grows. */
export const APNS_MAX_BYTES = 4096;
const BODY_CAP = 500;

export interface ApnsMessage {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export function buildApnsMessage(payload: PushPayload, topic: string): ApnsMessage {
  const body: Record<string, unknown> = {
    aps: {
      alert: {
        title: payload.title,
        body: payload.body.length > BODY_CAP ? `${payload.body.slice(0, BODY_CAP - 1)}…` : payload.body,
      },
      sound: "default",
      ...(payload.tag ? { "thread-id": payload.tag } : {}),
    },
  };
  if (payload.url) body.url = payload.url;
  if (payload.data) body.data = payload.data;

  const headers: Record<string, string> = {
    "apns-topic": topic,
    "apns-push-type": "alert",
    "apns-priority": "10",
  };
  // Apple limits the collapse id to 64 bytes.
  if (payload.tag) headers["apns-collapse-id"] = payload.tag.slice(0, 64);
  return { body, headers };
}

/** A device token is 32 bytes as 64 hex characters (longer on newer
 * devices is allowed by Apple, so only the alphabet is checked). */
export function normaliseDeviceToken(raw: string): string | null {
  const token = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{32,400}$/.test(token)) return null;
  return token;
}

export function parseEnvironment(raw: string | undefined): ApnsEnvironment {
  return raw === "sandbox" ? "sandbox" : "production";
}

/**
 * Whether Apple's answer means the token is dead and its row should go.
 * `410` is Unregistered; `400` with these reasons is a token that never
 * was, or was minted for another app or the other gateway.
 */
export function isDeadToken(status: number, reason: string | undefined): boolean {
  if (status === 410) return true;
  if (status === 400) {
    return reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic" || reason === "Unregistered";
  }
  return false;
}
