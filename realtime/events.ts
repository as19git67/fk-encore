export type EventChannel =
  | "documents"
  | "photos"
  | "albums"
  | "feed"
  | "scan-queue"
  | "system";

/**
 * Envelope for every realtime event. Identical to the wire shape: the
 * publish API hands events directly to the in-process session manager,
 * which forwards them verbatim to connected WebSocket clients.
 *
 * Versioning: bump `version` for a given `type` whenever `payload`
 * shape changes in a backwards-incompatible way. Clients should branch
 * on the pair (`type`, `version`).
 */
export interface RealtimeEvent {
  /** uuid — used for client-side deduplication. */
  id: string;
  /**
   * Monotonically increasing cursor assigned by the outbox INSERT.
   * Clients persist the highest `seq` they've processed and pass it
   * back as `lastEventId` on reconnect to replay missed events.
   * Zero for transport-level events that are never persisted
   * (heartbeats, handshake notices).
   */
  seq: number;
  /** Target user (numeric user id rendered as a string). */
  userId: string;
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

/** Alias kept for callers that still distinguish "wire" from "internal". */
export type ClientEvent = RealtimeEvent;
