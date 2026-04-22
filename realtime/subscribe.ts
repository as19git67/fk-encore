import { api } from "encore.dev/api";
import { Query } from "encore.dev/api";
import log from "encore.dev/log";
import { getAuthData } from "~encore/auth";
import { randomUUID } from "crypto";
import { and, asc, eq, gt } from "drizzle-orm";

import db from "../db/database";
import { dbAll } from "../db/adapter";
import { realtimeEvents } from "../db/schema";
import type { ClientEvent, EventChannel } from "./events";
import { hasChannelPermission, parseChannels } from "./permissions";
import { sessionManager } from "./session-manager";

log.info("boot: realtime/subscribe.ts: all imports resolved");

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
 * Server-side keep-alive interval. 10 s comfortably beats the idle
 * timeouts of every reverse proxy we care about (nginx 60s, Traefik
 * 60s, Cloudflare WS 100s) and leaves enough head-room for the
 * client's 60 s heartbeat-timeout watchdog even if the event loop
 * is briefly saturated by scan workers.
 */
const HEARTBEAT_INTERVAL_MS = 10_000;

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
    // Belt-and-suspenders diagnostic: emit on both loggers at the
    // earliest point in the handler, before anything that could
    // throw or return early. If NEITHER line appears in the
    // container logs after a fresh connect, the deployed image
    // does not contain this code.
    console.log(
      `[realtime] subscribe handler ENTERED (console.log) at ${new Date().toISOString()}`,
    );
    log.info("realtime: subscribe handler ENTERED", {
      at: new Date().toISOString(),
    });

    const auth = getAuthData();
    if (!auth) {
      log.warn("realtime: subscribe handler has NO auth data — exiting");
      return;
    }
    const { userID, permissions } = auth;
    log.info("realtime: subscribe handler has auth", {
      userID,
      permissionCount: permissions.length,
    });

    const requested = parseChannels(handshake.channels);
    const allowed: EventChannel[] = [];
    const denied: EventChannel[] = [];
    for (const ch of requested) {
      if (hasChannelPermission(ch, permissions)) allowed.push(ch);
      else denied.push(ch);
    }
    log.info("realtime: channels resolved", { userID, allowed, denied });

    // Register the session BEFORE replaying so live events published
    // during replay reach the socket too. Any overlap with replayed
    // rows is deduplicated on the client by event id.
    const session = sessionManager.register(
      userID,
      new Set(allowed),
      stream,
    );
    log.info("realtime: session registered", { userID });

    log.info("realtime: about to send session.ready", { userID });
    await stream
      .send(systemEvent(userID, "session.ready", { channels: allowed }))
      .catch((err: unknown) => {
        log.warn("realtime: session.ready send rejected", {
          userID,
          error: (err as Error)?.message ?? String(err),
        });
      });
    log.info("realtime: session.ready send awaited", { userID });

    if (denied.length > 0) {
      log.info("realtime: about to send channel.denied", { userID });
      await stream
        .send(systemEvent(userID, "channel.denied", { channels: denied }))
        .catch(() => {});
      log.info("realtime: channel.denied send awaited", { userID });
    }

    // Replay missed events, if the client provided a cursor.
    const lastSeq = parseLastSeq(handshake.lastEventId);
    log.info("realtime: replay decision", { userID, lastSeq });
    if (lastSeq !== null) {
      try {
        await replayFromOutbox(userID, lastSeq, new Set(allowed), stream);
      } catch (err) {
        console.warn(
          `[realtime] replay failed for user=${userID} lastSeq=${lastSeq}: ${(err as Error).message}`,
        );
      }
      log.info("realtime: replay done", { userID });
    }

    // Application-level heartbeats keep the socket warm and let the
    // client detect a dead connection even when the TCP layer has no
    // reason to produce an error. A failed send surfaces the
    // disconnect via `session.close()`, causing `done` to resolve.
    //
    // Instrumentation uses `encore.dev/log` so events land in the
    // structured log pipeline (and container stdout); plain
    // `console.log` output is suppressed under `encore build docker`.
    // Drop these diagnostics once the streamOut delivery path is
    // confirmed healthy.
    let heartbeatTick = 0;
    const heartbeat = setInterval(() => {
      const tick = ++heartbeatTick;
      log.info("realtime: heartbeat tick", { tick, userID });
      stream
        .send(systemEvent(userID, "heartbeat", {}))
        .then(() => {
          log.info("realtime: heartbeat sent ok", { tick, userID });
        })
        .catch((err: unknown) => {
          log.warn("realtime: heartbeat send failed", {
            tick,
            userID,
            error: (err as Error)?.message ?? String(err),
          });
          session.close();
        });
    }, HEARTBEAT_INTERVAL_MS);

    log.info("realtime: subscribe handler ready", {
      userID,
      channels: allowed,
      denied,
    });

    try {
      await session.done;
    } finally {
      clearInterval(heartbeat);
      sessionManager.unregister(session);
      log.info("realtime: subscribe handler ended", {
        userID,
        ticks: heartbeatTick,
      });
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
