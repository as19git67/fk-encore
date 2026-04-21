import type { ClientEvent, EventChannel, RealtimeEvent } from "./events";

/**
 * Stream writer interface matching Encore's streamOut handler. Kept as
 * a local abstraction so unit tests can plug in a mock without pulling
 * the Encore runtime.
 */
export interface StreamWriter {
  send(msg: ClientEvent): Promise<void>;
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
 * Phase-1 assumption: single Encore instance. When scaling horizontally
 * the dispatcher below still works — every instance runs its own
 * PubSub subscription and only forwards to its locally connected
 * sessions, which is the desired behaviour.
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
   * Deliver an event to every local session of the target user that is
   * subscribed to the event's channel. Send failures are swallowed so
   * one dead socket does not break fan-out to the user's other tabs.
   */
  async dispatch(event: RealtimeEvent): Promise<void> {
    const set = this.sessionsByUser.get(event.userId as unknown as string);
    if (!set || set.size === 0) return;

    const outbound: ClientEvent = {
      id: event.id,
      seq: event.seq,
      userId: event.userId as unknown as string,
      channel: event.channel,
      type: event.type,
      resourceId: event.resourceId,
      timestamp: event.timestamp,
      payload: event.payload,
      version: event.version,
    };

    const sends: Promise<void>[] = [];
    for (const session of set) {
      if (!session.channels.has(event.channel)) continue;
      sends.push(
        session.stream.send(outbound).catch((err) => {
          console.warn(
            `[realtime] send failed for user=${session.userId} channel=${event.channel}: ${(err as Error).message}`,
          );
          // Surface the disconnect so the handler can clean up and the
          // subscribe endpoint returns.
          session.close();
        }),
      );
    }
    await Promise.all(sends);
  }

  /** Test/debug helper — number of connected sessions overall. */
  size(): number {
    let n = 0;
    for (const set of this.sessionsByUser.values()) n += set.size;
    return n;
  }
}

export const sessionManager = new SessionManager();
