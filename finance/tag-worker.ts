/**
 * Background worker for the finance AI tag suggestion queue.
 * Started as a side-effect import from finance/encore.service.ts.
 *
 * Polls finance_tag_queue for pending jobs and calls
 * suggestTagsForTransaction() for each. Concurrency defaults to 1
 * (llama.cpp is single-session); override with
 * FINANCE_TAG_WORKER_CONCURRENCY env var.
 */

import {
  DeferTagJobError,
  dequeueNextTagJob,
  deferTagJob,
  markTagJobDone,
  markTagJobFailed,
  resetStuckTagJobs,
} from "./tag-queue";
import { suggestTagsForTransaction } from "./tag-suggester";
import { LlmServiceUnavailableError, isLlmServiceHealthy } from "./llm-client";
import { withAiSlot, AiSlotTimeoutError } from "../ai-queue/slot-helper";

console.log("[boot] finance/tag-worker.ts: all imports resolved");

const POLL_INTERVAL_MS = parseInt(
  process.env.FINANCE_TAG_WORKER_POLL_MS ?? "30000",
  10,
);
const CONCURRENCY = parseInt(
  process.env.FINANCE_TAG_WORKER_CONCURRENCY ?? "1",
  10,
);

class FinanceTagWorker {
  private running = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  tick(): void {
    while (this.running < CONCURRENCY) {
      this.running++;
      this.processNext()
        .then((hadWork) => {
          this.running--;
          if (hadWork && this.running < CONCURRENCY) {
            setImmediate(() => this.tick());
          }
        })
        .catch((err) => {
          this.running--;
          console.error("[finance.tag-worker] tick error:", err);
        });
    }
  }

  private async processNext(): Promise<boolean> {
    const healthy = await isLlmServiceHealthy().catch(() => false);
    if (!healthy) return false;

    const job = await dequeueNextTagJob();
    if (!job) return false;

    try {
      await withAiSlot("llm", 2, "finance:tag-suggest", () =>
        suggestTagsForTransaction(job.transaction_id),
      );
      await markTagJobDone(job.id);
    } catch (err: any) {
      if (err instanceof DeferTagJobError || err instanceof LlmServiceUnavailableError || err instanceof AiSlotTimeoutError) {
        console.log(
          `[finance.tag-worker] deferring job ${job.id}: ${err.message}`,
        );
        await deferTagJob(job.id).catch(() => {});
        return false;
      }
      const msg = err?.message ?? String(err);
      console.error(`[finance.tag-worker] job ${job.id} failed:`, msg);
      await markTagJobFailed(job.id, msg).catch(() => {});
    }
    return true;
  }

  start(): void {
    this.pollTimer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.tick();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

const worker = new FinanceTagWorker();

/** Wake the worker. Call after enqueueing new jobs. */
export function triggerTagWorker(): void {
  worker.tick();
}

async function startWorker(): Promise<void> {
  await resetStuckTagJobs();
  console.log(
    `[finance.tag-worker] starting — concurrency=${CONCURRENCY}, poll=${POLL_INTERVAL_MS}ms`,
  );
  worker.start();
}

startWorker().catch((err) =>
  console.error("[finance.tag-worker] failed to start:", err),
);
