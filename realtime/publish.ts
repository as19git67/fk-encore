import { api } from "encore.dev/api";
import { randomUUID } from "crypto";
import { userEvents, type EventChannel } from "./events";

console.log("[boot] realtime/publish.ts: all imports resolved");

export interface PublishEventRequest {
  /**
   * Target users. One PubSub message is emitted per user (fan-out-on-
   * write). Empty array is a no-op. For album/team events with large
   * member counts we will switch to fan-out-on-read in phase 4.
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
    // share). Cheap since the lists are small in phase 1.
    const unique = Array.from(new Set(req.userIds));
    await Promise.all(
      unique.map((userId) =>
        userEvents.publish({
          id: randomUUID(),
          userId,
          channel: req.channel,
          type: req.type,
          resourceId: req.resourceId,
          timestamp,
          payload,
          version,
        }),
      ),
    );
  },
);
