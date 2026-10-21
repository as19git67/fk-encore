/**
 * Hands a running turn's events to the stream that shows them.
 *
 * Why not run the agent inside the stream handler: a browser can only
 * authenticate a WebSocket with `?token=`, and the gateway downgrades such a
 * token to the media scope (user/auth-handler.ts), under which every
 * `requirePermission("finance.view")` and its kin fails — in this service and
 * in every service the tools call. So the question goes in as an ordinary
 * POST with the full bearer token and the agent runs there; the WebSocket only
 * watches. It needs no permission beyond being the same user.
 *
 * In-process, like the realtime session manager: this runs as one instance.
 * The client picks the turn id, opens the stream, then posts the question, so
 * events that happen before the stream is attached are kept and replayed.
 */

import type { TurnEvent } from "./types";

/** How long a finished turn's events stay for a late subscriber. */
const KEEP_FINISHED_MS = 2 * 60_000;
/** How long a stream waits for its turn to be posted. */
const KEEP_PENDING_MS = 60_000;

type Listener = (event: TurnEvent) => void;

interface LiveTurn {
  userId: string;
  events: TurnEvent[];
  listeners: Set<Listener>;
  finished: boolean;
  /** Fired by the user's "Abbrechen"; the running turn stops at its next step. */
  controller: AbortController;
  expiry?: ReturnType<typeof setTimeout>;
}

const turns = new Map<string, LiveTurn>();

export const TURN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function expireIn(turnId: string, turn: LiveTurn, ms: number): void {
  if (turn.expiry) clearTimeout(turn.expiry);
  turn.expiry = setTimeout(() => {
    if (turns.get(turnId) === turn) turns.delete(turnId);
  }, ms);
  turn.expiry.unref?.();
}

function turnFor(turnId: string, userId: string): LiveTurn {
  const existing = turns.get(turnId);
  if (existing) {
    if (existing.userId !== userId) throw new Error("turn belongs to someone else");
    return existing;
  }
  const turn: LiveTurn = { userId, events: [], listeners: new Set(), finished: false, controller: new AbortController() };
  turns.set(turnId, turn);
  expireIn(turnId, turn, KEEP_PENDING_MS);
  return turn;
}

function isLast(event: TurnEvent): boolean {
  return event.type === "done" || event.type === "error" || event.type === "cancelled";
}

/** The emitter a running turn reports through. */
export function openTurn(turnId: string, userId: string): (event: TurnEvent) => void {
  const turn = turnFor(turnId, userId);
  if (turn.finished || turn.events.length) throw new Error("turn id already used");
  if (turn.expiry) clearTimeout(turn.expiry);
  return (event) => {
    if (turn.finished) return;
    turn.events.push(event);
    for (const listener of turn.listeners) {
      try {
        listener(event);
      } catch {
        turn.listeners.delete(listener);
      }
    }
    if (isLast(event)) {
      turn.finished = true;
      expireIn(turnId, turn, KEEP_FINISHED_MS);
    }
  };
}

/**
 * Replays what happened so far, then follows the turn. Resolves once the turn
 * is finished, or after `KEEP_PENDING_MS` if it was never posted.
 */
export function followTurn(turnId: string, userId: string, listener: Listener): Promise<void> {
  const turn = turnFor(turnId, userId);
  for (const event of turn.events) listener(event);
  if (turn.finished) return Promise.resolve();
  return new Promise((resolve) => {
    // Only while nothing has been posted: a running turn may take minutes.
    const giveUp = turn.events.length
      ? undefined
      : setTimeout(() => {
          turn.listeners.delete(wrapped);
          listener({ type: "error", message: "no question was posted for this turn" });
          resolve();
        }, KEEP_PENDING_MS + 1000);
    giveUp?.unref?.();
    const wrapped: Listener = (event) => {
      if (giveUp) clearTimeout(giveUp);
      listener(event);
      if (isLast(event)) {
        turn.listeners.delete(wrapped);
        resolve();
      }
    };
    turn.listeners.add(wrapped);
  });
}

/**
 * What the running turn listens to for a cancel. Taken before the turn is
 * opened, so a cancel that beat the question there still counts.
 */
export function turnSignal(turnId: string, userId: string): AbortSignal {
  return turnFor(turnId, userId).controller.signal;
}

/**
 * Stops a turn of this user's. False when there is nothing left to stop: the
 * turn is finished, or it is not (or no longer) known here.
 */
export function cancelTurn(turnId: string, userId: string): boolean {
  const turn = turns.get(turnId);
  if (!turn || turn.userId !== userId || turn.finished) return false;
  turn.controller.abort();
  return true;
}

/** Reset for tests. */
export function __resetLiveTurnsForTests(): void {
  for (const turn of turns.values()) if (turn.expiry) clearTimeout(turn.expiry);
  turns.clear();
}
