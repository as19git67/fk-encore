import { Topic, Attribute } from "encore.dev/pubsub";

export type EventChannel =
  | "documents"
  | "photos"
  | "albums"
  | "feed"
  | "system";

/**
 * Envelope for every realtime event. The same shape is used for PubSub
 * messages and for the outbound WebSocket stream — clients receive the
 * exact JSON below (minus the `Attribute<>` marker, which is a compile-
 * time wrapper treated as `string` at runtime).
 *
 * Versioning: bump `version` for a given `type` whenever `payload` shape
 * changes in a backwards-incompatible way. Clients should branch on the
 * pair (`type`, `version`).
 */
export interface RealtimeEvent {
  /** uuid — used for deduplication and resume (phase 4). */
  id: string;
  /** Target user. Attribute drives PubSub ordering per user. */
  userId: Attribute<string>;
  channel: EventChannel;
  /** Event name inside the channel, e.g. "status.changed". */
  type: string;
  /** Primary key of the affected resource (document id, photo id, …). */
  resourceId: string;
  /** ISO-8601 timestamp set by the publisher. */
  timestamp: string;
  /** Event-specific data; may be empty. */
  payload: Record<string, unknown>;
  /** Schema version for this (channel, type) pair. Starts at 1. */
  version: number;
}

/**
 * Client-facing event shape. Identical to `RealtimeEvent` at runtime —
 * the `Attribute<>` marker is stripped so the stream handler can
 * forward messages without a cast.
 */
export interface ClientEvent {
  id: string;
  userId: string;
  channel: EventChannel;
  type: string;
  resourceId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  version: number;
}

/**
 * Single per-user topic. `orderingAttribute: "userId"` guarantees that
 * events for the same user are delivered in publish order, which is
 * important for status chains like pending → extracting → ready.
 */
export const userEvents = new Topic<RealtimeEvent>("user-events", {
  deliveryGuarantee: "at-least-once",
  orderingAttribute: "userId",
});
