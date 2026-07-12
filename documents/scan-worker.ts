/**
 * Background scan worker — one per service in the documents pipeline.
 * Started as a side-effect of importing this module from
 * `documents/encore.service.ts`.
 *
 * Unlike the photo worker the documents pipeline is strictly serial
 * per document (text_extract → classify → embed), so `classify` and
 * `embed` always defer when the upstream hasn't finished yet. The
 * global `triggerWorkers()` call after each successful job wakes all
 * workers so the chain moves forward without waiting on the poll
 * timer.
 *
 * Concurrency per service:
 *   DOC_SCAN_TEXT_CONCURRENCY  (default 1 — Tesseract is CPU-bound)
 *   DOC_SCAN_CLASSIFY_CONCURRENCY (default 1 — llama.cpp is single-session)
 *   DOC_SCAN_EMBED_CONCURRENCY (default 1)
 */

import {
  DeferJobError,
  dequeueNextJob,
  deferJob,
  markJobDone,
  markJobFailed,
  resetStuckJobs,
  type DocumentScanService,
} from "./scan-queue";
import {
  runClassify,
  runEmbed,
  runReceiptOcr,
  runTextExtract,
  markDocumentFailed,
} from "./document-ops";
import {
  LlmServiceUnavailableError,
  isLlmServiceHealthy,
} from "./llm-client";
import { ReceiptOcrUnavailableError } from "./receipt-ocr-client";
import { withAiSlot, AiSlotTimeoutError, type AiModel } from "../ai-queue/slot-helper";
import { notifyDocScanQueueChanged } from "./scan-queue-events";

console.log("[boot] documents/scan-worker.ts: all imports resolved");

const POLL_INTERVAL_MS = parseInt(process.env.DOC_SCAN_POLL_INTERVAL_MS ?? "30000", 10);

const AI_MODEL_MAP: Partial<Record<DocumentScanService, AiModel>> = {
  classify: "llm",
  embed: "embedding",
};

class DocumentScanWorker {
  private running = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly service: DocumentScanService,
    readonly concurrency: number,
  ) {}

  tick(): void {
    while (this.running < this.concurrency) {
      this.running++;
      this.processNext()
        .then((hadWork) => {
          this.running--;
          if (hadWork && this.running < this.concurrency) {
            setImmediate(() => this.tick());
          }
        })
        .catch((err) => {
          this.running--;
          console.error(`[documents.scan-worker] ${this.service} tick error:`, err);
        });
    }
  }

  private async processNext(): Promise<boolean> {
    // classify/embed talk to the LLM service — back off if it's down
    // so we don't burn retries on a cold-start window.
    if (this.service === "classify" || this.service === "embed") {
      const healthy = await isLlmServiceHealthy().catch(() => false);
      if (!healthy) return false;
    }

    const job = await dequeueNextJob(this.service);
    if (!job) return false;

    try {
      const aiModel = AI_MODEL_MAP[this.service];
      if (aiModel) {
        const aiPriority = Math.max(1, job.priority ?? 2);
        const requester = job.priority === 0
          ? `documents:${this.service}:receipt`
          : `documents:${this.service}`;
        await withAiSlot(aiModel, aiPriority, requester, () => this.runJob(job));
      } else {
        await this.runJob(job);
      }
      await markJobDone(job.id);
      // Wake sibling workers so the pipeline advances without waiting
      // on the poll timer (text_extract → classify → embed).
      triggerWorkers();
    } catch (err: any) {
      if (err instanceof DeferJobError || err instanceof LlmServiceUnavailableError || err instanceof AiSlotTimeoutError || err instanceof ReceiptOcrUnavailableError) {
        console.log(`[documents.scan-worker] deferring ${this.service} job ${job.id}: ${err.message}`);
        await deferJob(job.id).catch(() => {});
        return false;
      }
      const msg = err?.message ?? String(err);
      console.error(`[documents.scan-worker] ${this.service} job ${job.id} failed:`, msg);
      await markJobFailed(job.id, msg).catch(() => {});
      notifyDocScanQueueChanged();
      // Only mark the document failed for the first-stage (text_extract)
      // and classify failures — a missing embedding is not worth
      // blocking the document from appearing in the UI.
      if (this.service !== "embed") {
        await markDocumentFailed(job.document_id, msg).catch(() => {});
      }
    }
    return true;
  }

  private async runJob(job: { document_id: number }): Promise<void> {
    switch (this.service) {
      case "text_extract":
        await runTextExtract(job.document_id);
        return;
      case "classify": {
        const res = await runClassify(job.document_id);
        if ("deferred" in res) {
          throw new DeferJobError("text_extract not finished");
        }
        return;
      }
      case "embed": {
        const res = await runEmbed(job.document_id);
        if ("deferred" in res) {
          throw new DeferJobError("text_extract not finished");
        }
        return;
      }
      case "receipt_ocr":
        await runReceiptOcr(job.document_id);
        return;
    }
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

const textConcurrency = parseInt(process.env.DOC_SCAN_TEXT_CONCURRENCY ?? "1", 10);
const classifyConcurrency = parseInt(process.env.DOC_SCAN_CLASSIFY_CONCURRENCY ?? "1", 10);
const embedConcurrency = parseInt(process.env.DOC_SCAN_EMBED_CONCURRENCY ?? "1", 10);
const receiptOcrConcurrency = parseInt(process.env.DOC_SCAN_RECEIPT_OCR_CONCURRENCY ?? "1", 10);

const textExtractWorker = new DocumentScanWorker("text_extract", textConcurrency);
const classifyWorker = new DocumentScanWorker("classify", classifyConcurrency);
const embedWorker = new DocumentScanWorker("embed", embedConcurrency);
const receiptOcrWorker = new DocumentScanWorker("receipt_ocr", receiptOcrConcurrency);

const ALL_WORKERS = [textExtractWorker, classifyWorker, embedWorker, receiptOcrWorker];

/** Wake every worker. Non-blocking; call after enqueueing new jobs. */
export function triggerWorkers(): void {
  for (const w of ALL_WORKERS) w.tick();
  notifyDocScanQueueChanged();
}

async function startWorkers(): Promise<void> {
  await resetStuckJobs();
  console.log(
    `[documents.scan-worker] starting — text_extract(c=${textConcurrency}), classify(c=${classifyConcurrency}), embed(c=${embedConcurrency}), receipt_ocr(c=${receiptOcrConcurrency})`,
  );
  for (const w of ALL_WORKERS) w.start();
}

// Kick off workers at module load (i.e. once the `documents` Encore
// service boots). `initializeDb` has already resolved at this point —
// otherwise the `drizzle` import in scan-queue.ts would have thrown.
startWorkers().catch((err) =>
  console.error("[documents.scan-worker] failed to start:", err),
);
