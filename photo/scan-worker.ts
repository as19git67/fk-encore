/**
 * Background scan workers — one per service (embedding, face_detection, landmark, quality).
 * Workers are started as a side-effect of importing this module (via encore.service.ts).
 *
 * Concurrency per worker is configurable via environment variables:
 *   SCAN_EMBEDDING_CONCURRENCY   (default: 1)
 *   SCAN_FACE_CONCURRENCY        (default: 1)
 *   SCAN_LANDMARK_CONCURRENCY    (default: 1)
 *   SCAN_QUALITY_CONCURRENCY     (default: 1)
 */

import {
  dequeueNextJob,
  deferJob,
  markJobDone,
  markJobFailed,
  resetStuckJobs,
  DeferJobError,
  type ScanService,
} from "./scan-queue";
import {
  indexPhotoEmbeddings,
  indexPhotoFaces,
  indexPhotoLandmarks,
  indexPhotoQuality,
  findPhotoGroupsLogic,
  cleanupOrphanedPersons,
} from "./photo.service";
import {
  assertServiceAvailable,
  isServiceAvailable,
  ServiceUnavailableError,
  onServiceRecovered,
  startHealthChecks,
  type ExternalServiceName,
} from "./service-health";

const POLL_INTERVAL_MS = 30_000; // fallback poll when idle

/** Maps each scan-service to the external ML-service it depends on. */
const SERVICE_DEPENDENCY: Partial<Record<ScanService, ExternalServiceName>> = {
  embedding: "embedding",
  face_detection: "insightface",
  landmark: "landmark",
  quality: "embedding",
};

class ScanWorker {
  private running = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly service: ScanService,
    readonly concurrency: number,
  ) {}

  /**
   * Called after enqueueing new work or on a timer. Fills concurrency slots.
   * Only reschedules immediately if a job was actually processed; otherwise
   * the worker goes idle and waits for the next timer tick or triggerWorkers().
   * This prevents a busy-loop of DB queries when the queue is empty.
   */
  tick(): void {
    while (this.running < this.concurrency) {
      this.running++;
      this.processNext().then((hadWork) => {
        this.running--;
        // Only chase more work immediately when there was something to process.
        // If the queue was empty, stop here — the periodic timer will wake us.
        if (hadWork && this.running < this.concurrency) {
          this.tick();
        }
      }).catch(() => {
        this.running--;
      });
    }
  }

  /**
   * Dequeues and processes one job.
   * Returns true if a job was found and processed (or failed), false if the
   * queue was empty or the job was deferred (service unavailable).
   * Returning false on defer prevents a busy-loop: the worker stops chasing
   * work and waits for the service-recovery callback or the next timer tick.
   */
  private async processNext(): Promise<boolean> {
    // Pre-check: if the required service is down, don't even dequeue.
    // This avoids the dequeue→defer→re-dequeue busy-loop entirely.
    const dep = SERVICE_DEPENDENCY[this.service];
    if (dep && !isServiceAvailable(dep)) {
      return false;
    }

    const job = await dequeueNextJob(this.service);
    if (!job) return false; // queue empty — stop polling

    try {
      await this.runJob(job);
      await markJobDone(job.id);

      // After embedding completes, try to re-group similar photos
      if (this.service === "embedding") {
        findPhotoGroupsLogic(job.user_id).catch((err) =>
          console.error(`[scan-worker] grouping error after embedding job ${job.id}:`, err),
        );
      }

      // After face detection completes, clean up orphaned persons.
      if (this.service === "face_detection") {
        cleanupOrphanedPersons(job.user_id).catch((err) =>
          console.error(`[scan-worker] cleanup error after face job ${job.id}:`, err),
        );
      }
    } catch (err: any) {
      if (err instanceof DeferJobError || err instanceof ServiceUnavailableError) {
        console.log(`[scan-worker] deferring ${this.service} job ${job.id}: ${err.message}`);
        await deferJob(job.id).catch(() => {});
        // Return false so the worker stops chasing work immediately.
        // The service-recovery callback will wake us when the service is back.
        return false;
      } else {
        const msg = err?.message ?? String(err);
        console.error(`[scan-worker] ${this.service} job ${job.id} failed:`, msg);
        await markJobFailed(job.id, msg).catch(() => {});
      }
    }

    return true; // a job was dequeued and completed (or permanently failed)
  }

  private async runJob(job: { photo_id: number; user_id: number; force: boolean }): Promise<void> {
    // Check that the required external service is reachable before doing any work.
    // If it is not, throws ServiceUnavailableError which is caught above as a defer.
    const dep = SERVICE_DEPENDENCY[this.service];
    if (dep) assertServiceAvailable(dep);

    switch (this.service) {
      case "embedding":
        await indexPhotoEmbeddings(job.user_id, job.photo_id, job.force);
        break;
      case "face_detection":
        await indexPhotoFaces(job.user_id, job.photo_id, false);
        break;
      case "landmark":
        await indexPhotoLandmarks(job.user_id, job.photo_id);
        break;
      case "quality":
        await indexPhotoQuality(job.user_id, job.photo_id);
        break;
    }
  }

  start(): void {
    // Periodic fallback poll so we never miss work after a restart
    this.pollTimer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    // Kick immediately in case there's already work in the queue
    this.tick();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

const embeddingConcurrency = parseInt(process.env.SCAN_EMBEDDING_CONCURRENCY ?? "1", 10);
const faceConcurrency = parseInt(process.env.SCAN_FACE_CONCURRENCY ?? "1", 10);
const landmarkConcurrency = parseInt(process.env.SCAN_LANDMARK_CONCURRENCY ?? "1", 10);
const qualityConcurrency = parseInt(process.env.SCAN_QUALITY_CONCURRENCY ?? "1", 10);

const embeddingWorker = new ScanWorker("embedding", embeddingConcurrency);
const faceWorker = new ScanWorker("face_detection", faceConcurrency);
const landmarkWorker = new ScanWorker("landmark", landmarkConcurrency);
const qualityWorker = new ScanWorker("quality", qualityConcurrency);

/** Wake all workers to check for new work. Non-blocking. */
export function triggerWorkers(): void {
  embeddingWorker.tick();
  faceWorker.tick();
  landmarkWorker.tick();
  qualityWorker.tick();
}

export async function startWorkers(): Promise<void> {
  // Reset jobs that were stuck in 'processing' state when the server last stopped
  await resetStuckJobs();

  // Start external-service health-checks first.
  // Workers will defer (not fail) jobs when a required service is down.
  startHealthChecks();

  // Wake the relevant workers whenever a service comes back up.
  onServiceRecovered((name) => {
    if (name === "embedding") {
      embeddingWorker.tick();
      qualityWorker.tick();
    } else if (name === "insightface") {
      faceWorker.tick();
    } else if (name === "landmark") {
      landmarkWorker.tick();
    }
  });

  console.log("[scan-worker] Workers starting...");
  embeddingWorker.start();
  faceWorker.start();
  landmarkWorker.start();
  qualityWorker.start();
  console.log(
    `[scan-worker] embedding(c=${embeddingConcurrency}), face_detection(c=${faceConcurrency}), landmark(c=${landmarkConcurrency}), quality(c=${qualityConcurrency})`,
  );
}

// Start workers immediately when this module is loaded
startWorkers().catch((err) => console.error("[scan-worker] Failed to start workers:", err));
