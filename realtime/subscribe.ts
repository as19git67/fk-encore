import { api } from "encore.dev/api";
import { Query } from "encore.dev/api";
import { Subscription } from "encore.dev/pubsub";
import { getAuthData } from "~encore/auth";
import { randomUUID } from "crypto";

import {
  userEvents,
  type ClientEvent,
  type EventChannel,
} from "./events";
import { hasChannelPermission, parseChannels } from "./permissions";
import { sessionManager } from "./session-manager";

console.log("[boot] realtime/subscribe.ts: all imports resolved");

interface HandshakeParams {
  /** Comma-separated channel list, e.g. `"documents,photos"`. Omit to receive every channel the user is permitted for. */
  channels?: Query<string>;
  /** Reserved for phase-4 resume. Ignored in phase 1. */
  lastEventId?: Query<string>;
}

/**
 * Long-lived WebSocket carrying every realtime event for the
 * authenticated user. One connection serves every feature; clients
 * multiplex by `channel` + `type`. See `permissions.ts` for the
 * channel -> permission mapping.
 *
 * On handshake the server emits:
 *   - one `system/session.ready` event with the list of accepted channels
 *   - one `system/channel.denied` event per channel the user lacks
 *     permission for (fires only if any were denied)
 *
 * Clients that care about live-update availability should wait for
 * `session.ready` before assuming the stream is active.
 */
export const subscribe = api.streamOut<HandshakeParams, ClientEvent>(
  { path: "/realtime/subscribe", expose: true, auth: true },
  async (handshake, stream) => {
    const auth = getAuthData();
    if (!auth) return;
    const { userID, permissions } = auth;

    const requested = parseChannels(handshake.channels);
    const allowed: EventChannel[] = [];
    const denied: EventChannel[] = [];
    for (const ch of requested) {
      if (hasChannelPermission(ch, permissions)) allowed.push(ch);
      else denied.push(ch);
    }

    // Emit handshake bookkeeping events before registering the session
    // so the client sees them before any live event from another
    // publisher.
    await stream
      .send(systemEvent(userID, "session.ready", { channels: allowed }))
      .catch(() => {});
    if (denied.length > 0) {
      await stream
        .send(systemEvent(userID, "channel.denied", { channels: denied }))
        .catch(() => {});
    }

    const session = sessionManager.register(
      userID,
      new Set(allowed),
      stream,
    );
    try {
      await session.done;
    } finally {
      sessionManager.unregister(session);
    }
  },
);

/**
 * Dispatcher subscription — one per Encore instance. Forwards every
 * user-event to the locally connected sessions of the target user.
 * Remote users (connected to another instance) are handled by their
 * own dispatcher running on that instance.
 */
const _dispatcher = new Subscription(userEvents, "dispatch", {
  handler: async (ev) => {
    await sessionManager.dispatch(ev);
  },
});

function systemEvent(
  userID: string,
  type: string,
  payload: Record<string, unknown>,
): ClientEvent {
  return {
    id: randomUUID(),
    userId: userID,
    channel: "system",
    type,
    resourceId: userID,
    timestamp: new Date().toISOString(),
    payload,
    version: 1,
  };
}
