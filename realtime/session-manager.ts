import log from "encore.dev/log";
import type { ClientEvent, EventChannel, RealtimeEvent } from "./events";

/**
 * Stream writer interface matching Encore's streamOut handler. Kept as
 * a local abstraction so unit tests can plug in a mock without pulling
 * the Encore runtime.
 *
 * Encore.ts's streamOut `send()` is synchronous on the server side and
 * returns `undefined`, not a `Promise<void>` — see the long comment in
 * realtime/subscribe.ts. We type the return as `unknown` here so both
 * the real runtime and test mocks (which may legitimately return
 * `Promise<void>`) stay compatible.
 */
export interface StreamWriter {
  send(msg: ClientEvent): unknown;
  close?(): Promise<void>;
}

export interface Session {
  readonly userId: string;
  readonly channels: ReadonlySet<EventChannel>;
  readonly stream: StreamWriter;
  readonly done: Promise<void>;
  /** Resolve `done` — call on disconnect to release `await session.done`. */
  close(): void;
}

interface InternalSession extends Session {
  resolveDone: () => void;
}

/**
 * In-memory registry of connected WebSocket sessions, keyed by userId.
 * A user may have multiple concurrent sessions (multiple tabs, mobile
 * + desktop, etc.) so every userId maps to a Set.
 *
 * Single-instance assumption: `publish.ts` calls `dispatch` directly
 * after the outbox INSERT. Horizontal scaling would need a real
 * broker between the publisher and this dispatcher; for our self-host
 * deploy a process-local Map is enough.
 */
class SessionManager {
  private readonly sessionsByUser = new Map<string, Set<InternalSession>>();

  register(
    userId: string,
    channels: ReadonlySet<EventChannel>,
    stream: StreamWriter,
  ): Session {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const session: InternalSession = {
      userId,
      channels,
      stream,
      done,
      resolveDone,
      close: () => resolveDone(),
    };

    let set = this.sessionsByUser.get(userId);
    if (!set) {
      set = new Set();
      this.sessionsByUser.set(userId, set);
    }
    set.add(session);
    return session;
  }

  unregister(session: Session): void {
    const set = this.sessionsByUser.get(session.userId);
    if (!set) return;
    set.delete(session as InternalSession);
    if (set.size === 0) this.sessionsByUser.delete(session.userId);
  }

  /**
   * Deliver an event to every local session of the target user that
   * is subscribed to the event's channel.
   *
   * Encore.ts's streamOut `send()` is synchronous and returns
   * `undefined`; errors (most commonly `Error: channel closed` once
   * the browser has disconnected) are thrown synchronously. Catch
   * them per-session and `close()` the offending session so the
   * subscribe handler's `await session.done` unblocks and the stale
   * entry is unregistered.
   */
  async dispatch(event: RealtimeEvent): Promise<void> {
    const set = this.sessionsByUser.get(event.userId);
    if (!set || set.size === 0) return;

    const outbound: ClientEvent = event;
    for (const session of set) {
      if (!session.channels.has(event.channel)) continue;
      try {
        session.stream.send(outbound);
      } catch (err: unknown) {
        const message = (err as Error)?.message ?? String(err);
        if (message.includes("channel closed")) {
          log.info("realtime: dispatch on closed channel — closing session", {
            userId: session.userId,
            channel: event.channel,
            type: event.type,
          });
        } else {
          log.warn("realtime: dispatch send threw unexpectedly", {
            userId: session.userId,
            channel: event.channel,
            type: event.type,
            message,
          });
        }
        session.close();
      }
    }
  }

  /** Test/debug helper — number of connected sessions overall. */
  size(): number {
    let n = 0;
    for (const set of this.sessionsByUser.values()) n += set.size;
    return n;
  }
}

export const sessionManager = new SessionManager();
