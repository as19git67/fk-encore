import type { EventChannel } from "./events";

/**
 * Minimum permission required to subscribe to a channel. Mirrors the
 * `requirePermission` pattern used by regular API endpoints
 * (see `user/auth-handler.ts`).
 *
 * `null` means the channel is available to every authenticated user —
 * currently used by `system` for heartbeats and protocol-level notices
 * like `channel.denied`.
 *
 * Unknown channels fall through to `null` in `hasChannelPermission`, so
 * adding a new channel without updating this map defaults to "open".
 * Keep the map exhaustive to avoid surprises.
 */
export const CHANNEL_PERMISSIONS: Record<EventChannel, string | null> = {
  documents: "module.documents",
  photos: "module.photos",
  albums: "module.photos",
  feed: "module.photos",
  "scan-queue": "data.manage",
  system: null,
};

export function hasChannelPermission(
  channel: EventChannel,
  permissions: readonly string[],
): boolean {
  const required = CHANNEL_PERMISSIONS[channel];
  if (required === null || required === undefined) return true;
  return permissions.includes(required);
}

const ALL_CHANNELS: readonly EventChannel[] = [
  "documents",
  "photos",
  "albums",
  "feed",
  "scan-queue",
  "system",
];

/**
 * Parse a comma-separated channel list from the handshake query string.
 * Unknown channel names are silently dropped. An empty or missing input
 * yields every known channel — simpler clients can then rely on
 * permission filtering to only receive what they're allowed to see.
 */
export function parseChannels(raw: string | undefined | null): EventChannel[] {
  if (!raw) return [...ALL_CHANNELS];
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const allowed = new Set<EventChannel>();
  for (const name of requested) {
    if ((ALL_CHANNELS as readonly string[]).includes(name)) {
      allowed.add(name as EventChannel);
    }
  }
  // Every connection implicitly subscribes to the `system` channel so
  // the client always receives heartbeats and protocol notices.
  allowed.add("system");
  return Array.from(allowed);
}
