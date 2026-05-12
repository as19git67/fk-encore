import { aiqueue } from "~encore/clients";
import type { AiModel } from "./api";

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
const POLL_INTERVAL_MS = parseInt(
  process.env.AI_QUEUE_POLL_INTERVAL_MS ?? "1000",
  10,
);

export async function withAiSlot<T>(
  model: AiModel,
  priority: number,
  requester: string,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const slot = await aiqueue.acquireSlot({ model, priority, requester });
  let slotId = slot.slotId;

  try {
    if (slot.status === "waiting") {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        if (Date.now() >= deadline) {
          await aiqueue.cancelSlot({ slotId }).catch(() => {});
          throw new AiSlotTimeoutError(model, timeoutMs);
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const poll = await aiqueue.pollSlot({ slotId });
        if (poll.status === "active") break;
        if (poll.status === "cancelled") {
          throw new AiSlotTimeoutError(model, timeoutMs);
        }
      }
    }
    return await fn();
  } finally {
    await aiqueue.releaseSlot({ slotId }).catch(() => {});
  }
}
