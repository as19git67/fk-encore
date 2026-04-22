import { api } from "encore.dev/api";
import { Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { randomUUID } from "crypto";
import { and, asc, eq, gt } from "drizzle-orm";

import db from "../db/database";
import { dbAll } from "../db/adapter";
import { realtimeEvents } from "../db/schema";
import type { ClientEvent, EventChannel } from "./events";
import { hasChannelPermission, parseChannels } from "./permissions";
import { sessionManager } from "./session-manager";

console.log("[boot] realtime/subscribe.ts: all imports resolved");

interface HandshakeParams {
  /** Comma-separated channel list, e.g. `"documents,photos"`. Omit to receive every channel the user is permitted for. */
  channels?: Query<string>;
  /**
   * Highest `seq` the client has already processed. On reconnect, the
   * server replays every outbox row for this user with a greater
   * `seq` before resuming live delivery. Missing / non-numeric => no
   * replay (fresh session).
   */
  lastEventId?: Query<string>;
}

/**
 * Server-side keep-alive interval. Stays below the 60 s idle timeout
 * commonly applied by nginx / cloud load balancers so idle sockets
 * aren't silently dropped mid-session.
 */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Cap on the number of events replayed in a single handshake. A
 * client that has been offline long enough to miss more than this
 * should do a full reload rather than rely on incremental updates,
 * which is why we send `system/resume.truncated` when the cap hits.
 */
const REPLAY_LIMIT = 500;

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
 *   - a replay of every outbox event with seq > lastEventId (capped at
 *     REPLAY_LIMIT; if truncated a `system/resume.truncated` event is
 *     sent and the client should treat the session as a cold start)
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

    // Register the session BEFORE replaying so live events published
    // during replay reach the socket too. Any overlap with replayed
    // rows is deduplicated on the client by event id.
    const session = sessionManager.register(
      userID,
      new Set(allowed),
      stream,
    );

    await stream
      .send(systemEvent(userID, "session.ready", { channels: allowed }))
      .catch(() => {});
    if (denied.length > 0) {
      await stream
        .send(systemEvent(userID, "channel.denied", { channels: denied }))
        .catch(() => {});
    }

    // Replay missed events, if the client provided a cursor.
    const lastSeq = parseLastSeq(handshake.lastEventId);
    if (lastSeq !== null) {
      try {
        await replayFromOutbox(userID, lastSeq, new Set(allowed), stream);
      } catch (err) {
        console.warn(
          `[realtime] replay failed for user=${userID} lastSeq=${lastSeq}: ${(err as Error).message}`,
        );
      }
    }

    // Application-level heartbeats keep the socket warm and let the
    // client detect a dead connection even when the TCP layer has no
    // reason to produce an error. A failed send surfaces the
    // disconnect via `session.close()`, causing `done` to resolve.
    const heartbeat = setInterval(() => {
      stream
        .send(systemEvent(userID, "heartbeat", {}))
        .catch(() => session.close());
    }, HEARTBEAT_INTERVAL_MS);

    try {
      await session.done;
    } finally {
      clearInterval(heartbeat);
      sessionManager.unregister(session);
    }
  },
);

function systemEvent(
  userID: string,
  type: string,
  payload: Record<string, unknown>,
): ClientEvent {
  return {
    id: randomUUID(),
    // Transport-level events never touch the outbox, so they share
    // the sentinel seq=0. Clients must not advance their cursor on
    // system events.
    seq: 0,
    userId: userID,
    channel: "system",
    type,
    resourceId: userID,
    timestamp: new Date().toISOString(),
    payload,
    version: 1,
  };
}

function parseLastSeq(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

interface OutboxRow {
  id: string;
  seq: number;
  channel: string;
  type: string;
  resource_id: string;
  payload: Record<string, unknown>;
  version: number;
  created_at: string;
}

async function replayFromOutbox(
  userID: string,
  lastSeq: number,
  allowedChannels: ReadonlySet<EventChannel>,
  stream: { send(msg: ClientEvent): Promise<void> },
): Promise<void> {
  const userIdNum = Number(userID);
  if (!Number.isInteger(userIdNum)) return;

  const rows = await dbAll<OutboxRow>(
    db
      .select({
        id: realtimeEvents.id,
        seq: realtimeEvents.seq,
        channel: realtimeEvents.channel,
        type: realtimeEvents.type,
        resource_id: realtimeEvents.resource_id,
        payload: realtimeEvents.payload,
        version: realtimeEvents.version,
        created_at: realtimeEvents.created_at,
      })
      .from(realtimeEvents)
      .where(
        and(
          eq(realtimeEvents.user_id, userIdNum),
          gt(realtimeEvents.seq, lastSeq),
        ),
      )
      .orderBy(asc(realtimeEvents.seq))
      .limit(REPLAY_LIMIT + 1),
  );

  const truncated = rows.length > REPLAY_LIMIT;
  const toSend = truncated ? rows.slice(0, REPLAY_LIMIT) : rows;

  for (const row of toSend) {
    // Skip events for channels the client didn't subscribe to this
    // session (e.g. permission was revoked while offline). The row
    // stays in the outbox — future sessions with the right scope can
    // still see it until retention removes it.
    if (!allowedChannels.has(row.channel as EventChannel)) continue;
    await stream
      .send({
        id: row.id,
        seq: row.seq,
        userId: userID,
        channel: row.channel as EventChannel,
        type: row.type,
        resourceId: row.resource_id,
        timestamp: row.created_at,
        payload: row.payload,
        version: row.version,
      })
      .catch(() => {});
  }

  if (truncated) {
    await stream
      .send(
        systemEvent(userID, "resume.truncated", {
          replayed: toSend.length,
          limit: REPLAY_LIMIT,
        }),
      )
      .catch(() => {});
  }
}
