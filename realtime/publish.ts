import { api } from "encore.dev/api";
import { randomUUID } from "crypto";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import { realtimeEvents } from "../db/schema";
import type { EventChannel } from "./events";
import { sessionManager } from "./session-manager";

console.log("[boot] realtime/publish.ts: all imports resolved");

export interface PublishEventRequest {
  /**
   * Target users. One outbox row + PubSub message is emitted per user
   * (fan-out-on-write). Empty array is a no-op. For album/team events
   * with large member counts we will switch to fan-out-on-read in a
   * later phase.
   */
  userIds: string[];
  channel: EventChannel;
  /** Event name inside the channel, e.g. `"status.changed"`. */
  type: string;
  /** Primary key of the affected resource. */
  resourceId: string;
  /** Event-specific data. Must be JSON-serialisable. */
  payload?: Record<string, unknown>;
  /** Schema version for this (channel, type). Defaults to 1. */
  version?: number;
}

/**
 * Internal publishing API used by other services (documents, photo,
 * …). Marked `expose: false` so the endpoint is only reachable via the
 * generated `~encore/clients` import, never from the public gateway.
 *
 * The helper intentionally does NOT check permissions: the caller
 * owns the decision about who should receive the event. Permission
 * filtering happens on the subscribe side.
 *
 * Per recipient we INSERT a row into the outbox (getting a monotonic
 * `seq` back) and then hand the event to the in-process session
 * manager which forwards it to every connected WebSocket session of
 * that user. The DB write happens first so a client resuming after a
 * crash still sees the event via outbox replay even if it was offline
 * during the live dispatch.
 */
export const publishEvent = api(
  { expose: false },
  async (req: PublishEventRequest): Promise<void> => {
    if (req.userIds.length === 0) return;
    const timestamp = new Date().toISOString();
    const payload = req.payload ?? {};
    const version = req.version ?? 1;
    // Deduplicate to avoid sending the same event twice to a user who
    // appears more than once in the callers list (e.g. owner + explicit
    // share). Cheap since the lists are small.
    const unique = Array.from(new Set(req.userIds));
    await Promise.all(
      unique.map(async (userId) => {
        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum)) {
          console.warn(
            `[realtime] publishEvent: skipping non-integer userId=${userId}`,
          );
          return;
        }
        const id = randomUUID();
        const row = await dbFirst<{ seq: number }>(
          db
            .insert(realtimeEvents)
            .values({
              id,
              user_id: userIdNum,
              channel: req.channel,
              type: req.type,
              resource_id: req.resourceId,
              payload,
              version,
            })
            .returning({ seq: realtimeEvents.seq }),
        );
        if (!row) {
          console.warn(`[realtime] publishEvent: outbox INSERT returned no row (user=${userId})`);
          return;
        }
        await sessionManager.dispatch({
          id,
          seq: row.seq,
          userId,
          channel: req.channel,
          type: req.type,
          resourceId: req.resourceId,
          timestamp,
          payload,
          version,
        });
      }),
    );
  },
);

export interface ConnectionStatusRequest {
  /** User id to check, as a string (matches the realtime session key). */
  userId: string;
}

export interface ConnectionStatusResponse {
  /** True if the user has at least one live WebSocket session on this instance. */
  connected: boolean;
}

/**
 * Internal presence probe used by the push layer to decide whether a
 * recipient is currently in the app. When connected, the user already
 * receives the realtime event live, so the Web Push can be suppressed.
 *
 * Process-local (single-instance assumption, see session-manager).
 */
export const connectionStatus = api(
  { expose: false },
  async (req: ConnectionStatusRequest): Promise<ConnectionStatusResponse> => {
    return { connected: sessionManager.isConnected(req.userId) };
  },
);
