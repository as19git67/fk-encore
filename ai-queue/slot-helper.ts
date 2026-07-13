import { aiqueue } from "~encore/clients";
import type { AiModel } from "./api";
import { registerWaiter, unregisterWaiter } from "./waiters";

export type { AiModel } from "./api";

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

export async function withAiSlot<T>(
  model: AiModel,
  priority: number,
  requester: string,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
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
      const result = await fn();
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
