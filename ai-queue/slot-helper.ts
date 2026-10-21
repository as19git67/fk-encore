import { AsyncLocalStorage } from "node:async_hooks";
import { aiqueue } from "~encore/clients";
import type { AiModel } from "./api";
import { registerWaiter, unregisterWaiter } from "./waiters";

export type { AiModel } from "./api";

/**
 * Who goes first when several callers wait for the same model. Lower wins;
 * equal priorities are served in arrival order.
 *
 * The assistant has a level to itself: somebody is watching the answer being
 * written, so it takes the next free slot even while a batch classification
 * or a backfill has a hundred jobs queued. Nothing else may ask for 0 — the
 * document queue's most urgent jobs (receipts) are clamped to `urgent`.
 */
export const AI_PRIORITY = {
  assistant: 0,
  urgent: 1,
  background: 2,
  idle: 5,
} as const;

/**
 * What the current async call chain already has.
 *
 * `priority` is the lane a whole piece of work runs in (the assistant's turn,
 * including its tool calls between two model rounds), so a model call deep in
 * a tool is not queued as background. `held` are the slots a caller up the
 * chain owns: a worker that took the llm slot for a whole job must not queue
 * again for the same slot inside it, or it would wait for itself.
 */
interface SlotContext {
  priority?: number;
  held: ReadonlyMap<AiModel, { released: boolean }>;
}

const context = new AsyncLocalStorage<SlotContext>();

/**
 * Runs `fn` so that every slot it asks for is queued at `priority` or better.
 * Holds no slot itself.
 */
export function withAiPriority<T>(priority: number, fn: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  return context.run({ priority, held: current?.held ?? new Map() }, fn);
}

/**
 * The llm slot for one background call to the llm-service. Every client that
 * reaches the model goes through here or through a worker's own slot, so the
 * assistant never finds the service's one inference slot taken by a caller
 * that skipped the line.
 */
export function withLlmSlot<T>(requester: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
  return withAiSlot("llm", AI_PRIORITY.background, requester, fn, timeoutMs);
}

export class AiSlotTimeoutError extends Error {
  constructor(model: AiModel, timeoutMs: number) {
    super(`ai-queue slot timed out after ${timeoutMs}ms for model '${model}'`);
    this.name = "AiSlotTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.AI_QUEUE_SLOT_TIMEOUT_MS ?? "300000",
  10,
);

// Safety-net poll interval while waiting for a slot. In the normal case the
// waiter is woken instantly by releaseSlot/cleanup (see ai-queue/waiters.ts),
// so this only fires if a wakeup was ever lost (bug, or a future multi-process
// topology). Kept coarse on purpose — it is not the primary progress mechanism.
// Read per call (not cached at import) so it stays overridable in tests.
function fallbackPollMs(): number {
  return parseInt(process.env.AI_QUEUE_FALLBACK_POLL_MS ?? "30000", 10);
}

/** setTimeout wrapped as a cancelable promise so we never leak a live timer. */
function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(handle!) };
}

/**
 * Wait until the slot becomes active, driven by a push wakeup rather than a
 * per-second poll. The DB stays the source of truth: every wakeup (and every
 * fallback tick) is confirmed with a single pollSlot.
 *
 * Race handling: the waiter is registered BEFORE each pollSlot re-check, so a
 * promotion+wakeup that lands between iterations is never lost — the wakeup
 * either resolves the current wait or the immediately-following poll observes
 * `active`.
 */
async function waitForActiveSlot(
  slotId: number,
  model: AiModel,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    // Register first, then re-check — this closes the window between the
    // acquireSlot response (or a previous iteration) and registration.
    const wakeup = registerWaiter(slotId);
    try {
      const poll = await aiqueue.pollSlot({ slotId });
      if (poll.status === "active") return;
      if (poll.status === "cancelled") {
        throw new AiSlotTimeoutError(model, timeoutMs);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Give up. cancelSlot removes the row only while it is still `waiting`,
        // which prevents the finally-releaseSlot in withAiSlot from wrongly
        // promoting a second active slot. If the slot raced to `active` in the
        // meantime, cancelSlot is a no-op and withAiSlot's releaseSlot frees it
        // (and promotes the next waiter) instead.
        await aiqueue.cancelSlot({ slotId }).catch(() => {});
        throw new AiSlotTimeoutError(model, timeoutMs);
      }

      const timer = sleep(Math.min(remaining, fallbackPollMs()));
      try {
        await Promise.race([wakeup, timer.promise]);
      } finally {
        timer.cancel();
      }
    } finally {
      unregisterWaiter(slotId);
    }
  }
}

/**
 * Runs `fn` while holding `model`'s slot, waiting in line first if needed.
 *
 * Inside a call chain that already holds this slot it runs `fn` directly. A
 * fire-and-forget started inside a job and still going after the job let go
 * of its slot queues like anyone else.
 */
export async function withAiSlot<T>(
  model: AiModel,
  priority: number,
  requester: string,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const current = context.getStore();
  const owned = current?.held.get(model);
  if (owned && !owned.released) return fn();
  if (current?.priority !== undefined) priority = Math.min(priority, current.priority);

  const token = { released: false };
  const held = new Map(current?.held ?? []);
  held.set(model, token);
  const inner: SlotContext = { priority: current?.priority, held };

  const slot = await aiqueue.acquireSlot({ model, priority, requester });
  const slotId = slot.slotId;
  const acquiredAt = Date.now();
  console.log(
    `[ai-queue] ${requester} acquired ${model} slot ${slotId} ` +
      `status=${slot.status} position=${slot.position}`,
  );

  try {
    if (slot.status === "waiting") {
      console.log(
        `[ai-queue] ${requester} waiting for ${model} slot ${slotId} ` +
          `position=${slot.position}`,
      );
      await waitForActiveSlot(slotId, model, timeoutMs);
      console.log(
        `[ai-queue] ${requester} ${model} slot ${slotId} became active ` +
          `after ${Date.now() - acquiredAt}ms`,
      );
    }
    const runStartedAt = Date.now();
    console.log(
      `[ai-queue] ${requester} running with active ${model} slot ${slotId}`,
    );
    try {
      const result = await context.run(inner, fn);
      console.log(
        `[ai-queue] ${requester} finished ${model} slot ${slotId} ` +
          `in ${Date.now() - runStartedAt}ms`,
      );
      return result;
    } catch (err: any) {
      console.warn(
        `[ai-queue] ${requester} failed while using ${model} slot ${slotId} ` +
          `after ${Date.now() - runStartedAt}ms: ${err?.message ?? err}`,
      );
      throw err;
    }
  } finally {
    token.released = true;
    // Frees the slot (and promotes the next waiter) whether we ran, timed out
    // after racing to active, or fn() threw. A no-op if the row is already gone
    // (e.g. cancelSlot removed a still-waiting slot on timeout).
    await aiqueue.releaseSlot({ slotId }).catch((err: any) => {
      console.warn(
        `[ai-queue] ${requester} could not release ${model} slot ${slotId}: ` +
          `${err?.message ?? err}`,
      );
    });
    console.log(
      `[ai-queue] ${requester} released ${model} slot ${slotId} ` +
        `after ${Date.now() - acquiredAt}ms total`,
    );
  }
}
