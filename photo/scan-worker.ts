/**
 * Background scan workers — one per service (embedding, face_detection, landmark, quality, geocoding).
 * Workers are started as a side-effect of importing this module (via encore.service.ts).
 *
 * Concurrency per worker is configurable via environment variables:
 *   SCAN_EMBEDDING_CONCURRENCY   (default: 1)
 *   SCAN_FACE_CONCURRENCY        (default: 1)
 *   SCAN_LANDMARK_CONCURRENCY    (default: 1)
 *   SCAN_QUALITY_CONCURRENCY     (default: 1)
 *
 * The geocoding worker always runs at concurrency 1 with a 1.1s delay
 * between jobs to respect the Nominatim rate limit (1 req/s).
 */

import {
  dequeueNextJob,
  deferJob,
  markJobDone,
  markJobFailed,
  resetStuckJobs,
  enqueuePhotoScan,
  DeferJobError,
  type ScanService,
} from "./scan-queue";
import {
  dequeueNextLibraryScan,
  markLibraryScanDone,
  markLibraryScanFailed,
  resetStuckLibraryScans,
} from "./library-scan-queue";
import {
  indexPhotoEmbeddings,
  detectPhotoFaces,
  assignFacesForUser,
  indexPhotoLandmarks,
  indexPhotoQuality,
  indexPhotoGeocoding,
  indexPhotoThumbnails,
  scheduleRegroup,
  cleanupOrphanedPersons,
  hasFacesForPhoto,
  enqueueFaceAssignmentForAllUsers,
  getPhotoOwnerId,
  getUsersWithPhotoAccess,
} from "./photo.service";
import { scheduleRecapsRebuild } from "./recaps.service";

// Scan services whose completion can invalidate recaps for every user that
// can see the photo (global services have no user_id on the job itself).
//   - embedding: drives `theme`-recaps (CLIP-Cluster, future)
//   - quality:   affects curation ranking inside every recap
//   - geocoding: enables `trip` / `place` builders
const GLOBAL_RECAP_TRIGGER_SERVICES: Partial<Record<ScanService, true>> = {
  embedding: true,
  quality: true,
  geocoding: true,
};
import {
  assertServiceAvailable,
  isServiceAvailable,
  ServiceUnavailableError,
  onServiceRecovered,
  startHealthChecks,
  type ExternalServiceName,
} from "./service-health";
import {
  isUnderPressure,
  isUnderSoftPressure,
  getPressureLevel,
  startPressureMonitor,
  WORKER_PRESSURE_DELAY_MS,
  WORKER_HARD_PRESSURE_DELAY_MS,
} from "./event-loop-pressure";
import { acquireDbSlot, releaseDbSlot } from "./worker-db-slots";
import { MlRpcTimeoutError } from "./rpc-timeout";

console.log("[boot] photo/scan-worker.ts: all imports resolved");

const POLL_INTERVAL_MS = 30_000; // fallback poll when idle

/** Maps each scan-service to the external ML-service it depends on. */
const SERVICE_DEPENDENCY: Partial<Record<ScanService, ExternalServiceName>> = {
  embedding: "embedding",
  face_detection: "insightface",
  // face_assignment has no external dependency — it only reads from the local DB
  landmark: "landmark",
  quality: "embedding",
};

/**
 * Services that are EXPENSIVE (hold a DB connection across a large external
 * RPC and/or do HEIC decoding on the libuv thread pool). When the event loop
 * reports soft pressure we skip dequeuing these so user-facing traffic can
 * catch up. Cheap services (face_assignment, geocoding, thumbnail) still
 * run under soft pressure because pausing them would leave the queue
 * visibly stuck for users even when the server could handle them.
 *
 * thumbnail is intentionally NOT marked expensive: it offloads sharp() to
 * the worker_threads pool (see photo/image-pool.ts) so the main event loop
 * is unaffected.
 */
const EXPENSIVE_SERVICES: Partial<Record<ScanService, true>> = {
  embedding: true,
  face_detection: true,
  landmark: true,
  quality: true,
};

/**
 * Global pause flag — flipped by the backup service while a DB backup /
 * ZFS snapshot is in flight. While paused:
 *   - no new jobs are dequeued (processNext returns early)
 *   - triggerWorkers() becomes a no-op
 *   - the periodic poll timer keeps running but has no effect
 * In-flight jobs are allowed to finish so pg_backup_start() is called only
 * once the queue has drained.
 */
let workersPaused = false;

export function areWorkersPaused(): boolean {
  return workersPaused;
}

class ScanWorker {
  private running = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly service: ScanService,
    readonly concurrency: number,
  ) {}

  /**
   * Called after enqueueing new work or on a timer. Fills concurrency slots.
   * Only reschedules if a job was actually processed; otherwise the worker
   * goes idle and waits for the next timer tick or triggerWorkers().
   *
   * Between jobs the worker always yields to the event loop so that
   * latency-sensitive requests (health checks, UI queries) are not starved.
   * When the event loop is under pressure the worker adds an extra delay
   * to let the system recover before processing the next job.
   */
  tick(): void {
    while (this.running < this.concurrency) {
      this.running++;
      this.processNext().then((hadWork) => {
        this.running--;
        if (hadWork && this.running < this.concurrency) {
          // Yield to the event loop before processing the next job.
          // Under pressure, add a longer delay so health checks get through.
          const level = getPressureLevel();
          const delay = level === "hard"
            ? WORKER_HARD_PRESSURE_DELAY_MS
            : level === "soft"
              ? WORKER_PRESSURE_DELAY_MS
              : 0;
          setTimeout(() => this.tick(), delay);
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
    // Pre-check: if a backup is running, do not dequeue. In-flight work
    // that was already picked up continues to run — pauseWorkers() waits
    // for that via waitForWorkersIdle() before pg_backup_start is called.
    if (workersPaused) {
      return false;
    }

    // Pre-check: if the event loop is under hard pressure, skip this cycle
    // so that health checks and other latency-sensitive requests can be
    // served in time.  The periodic timer will wake us once pressure drops.
    if (isUnderPressure()) {
      return false;
    }

    // Under soft pressure, defer expensive services (embedding, face_detection,
    // landmark, quality) that hold DB connections across a heavy RPC. Cheap
    // services keep flowing so the queue never looks stuck from the UI.
    if (isUnderSoftPressure() && EXPENSIVE_SERVICES[this.service]) {
      return false;
    }

    // Pre-check: if the required service is down, don't even dequeue.
    // This avoids the dequeue→defer→re-dequeue busy-loop entirely.
    const dep = SERVICE_DEPENDENCY[this.service];
    if (dep && !isServiceAvailable(dep)) {
      return false;
    }

    const job = await dequeueNextJob(this.service);
    if (!job) return false; // queue empty — stop polling

    // Reserve a DB slot so this worker cannot starve the HTTP handlers of
    // pool connections while it holds them across an external RPC call.
    // Released in finally below regardless of outcome.
    await acquireDbSlot();
    try {
      await this.runJob(job);
      await markJobDone(job.id);

      // After face_detection completes, enqueue face_assignment for ALL users
      // who have access to the photo (owner + shared album members).
      if (this.service === "face_detection") {
        enqueueFaceAssignmentForAllUsers(job.photo_id).catch((err) =>
          console.error(`[scan-worker] face_assignment enqueue error after face_detection job ${job.id}:`, err),
        );
      }

      // After embedding completes, re-group similar photos for all users
      // who can see this photo (owner + shared album members). Runs are
      // serialized per user via scheduleRegroup to avoid concurrent passes
      // clobbering each other's results.
      if (this.service === "embedding") {
        getUsersWithPhotoAccess(job.photo_id).then((userIds) => {
          for (const uid of userIds) {
            scheduleRegroup(uid);
          }
        }).catch((err) =>
          console.error(`[scan-worker] grouping lookup error after embedding job ${job.id}:`, err),
        );
      }

      // After face detection completes, re-enqueue quality so it can
      // include face composition data (quality no longer defers on
      // pending face_detection to avoid blocking during "scan missing").
      // Only re-enqueue when faces were actually found — otherwise the
      // quality score would be identical and the re-run is wasted work.
      if (this.service === "face_detection") {
        hasFacesForPhoto(job.photo_id).then((has) => {
          if (!has) return;
          // quality is a global service — userId=0 is ignored for global enqueue
          return enqueuePhotoScan(job.photo_id, 0, ["quality"]).then(() => {
            qualityWorker.tick();
          });
        }).catch((err) =>
          console.error(`[scan-worker] quality re-enqueue after face_detection job ${job.id}:`, err),
        );
      }

      // After face assignment completes, clean up orphaned persons.
      if (this.service === "face_assignment" && job.user_id) {
        cleanupOrphanedPersons(job.user_id).catch((err) =>
          console.error(`[scan-worker] cleanup error after face_assignment job ${job.id}:`, err),
        );
      }

      // Incremental recaps rebuild. Every completed job whose outcome can
      // change the recap feed schedules a debounced per-user rebuild via the
      // scheduler in recaps.service. The scheduler coalesces bursts, so even
      // a bulk scan that finishes 500 jobs in a minute triggers at most one
      // real rebuild per user.
      if (this.service === "face_assignment" && job.user_id) {
        scheduleRecapsRebuild(job.user_id).catch((err) =>
          console.error(`[scan-worker] recaps rebuild error after face_assignment job ${job.id}:`, err),
        );
      } else if (GLOBAL_RECAP_TRIGGER_SERVICES[this.service]) {
        getUsersWithPhotoAccess(job.photo_id).then((userIds) => {
          for (const uid of userIds) {
            scheduleRecapsRebuild(uid).catch((err) =>
              console.error(`[scan-worker] recaps rebuild error for user ${uid} after ${this.service} job ${job.id}:`, err),
            );
          }
        }).catch((err) =>
          console.error(`[scan-worker] recaps rebuild lookup error after ${this.service} job ${job.id}:`, err),
        );
      }
    } catch (err: any) {
      // MlRpcTimeoutError is treated as transient — the ML container may be
      // slow, under load, or restarting. Marking the job as permanently
      // failed would lose the photo's embedding/quality/landmark data until
      // someone manually re-scans. Defer instead so the next tick retries
      // once the container is responsive again.
      if (
        err instanceof DeferJobError ||
        err instanceof ServiceUnavailableError ||
        err instanceof MlRpcTimeoutError
      ) {
        console.log(`[scan-worker] deferring ${this.service} job ${job.id}: ${err.message}`);
        await deferJob(job.id).catch(() => {});
        // Return false so the worker stops chasing work immediately.
        // The service-recovery callback (or the next poll tick) will wake us.
        return false;
      } else {
        const msg = err?.message ?? String(err);
        console.error(`[scan-worker] ${this.service} job ${job.id} failed:`, msg);
        await markJobFailed(job.id, msg).catch(() => {});
      }
    } finally {
      releaseDbSlot();
    }

    return true; // a job was dequeued and completed (or permanently failed)
  }

  private async runJob(job: { photo_id: number; user_id: number | null; force: boolean }): Promise<void> {
    // Check that the required external service is reachable before doing any work.
    // If it is not, throws ServiceUnavailableError which is caught above as a defer.
    const dep = SERVICE_DEPENDENCY[this.service];
    if (dep) assertServiceAvailable(dep);

    switch (this.service) {
      case "embedding":
        await indexPhotoEmbeddings(job.photo_id, job.force);
        break;
      case "face_detection":
        // Global detection — runs once per photo regardless of user
        await detectPhotoFaces(job.photo_id, job.force);
        break;
      case "face_assignment":
        // Per-user assignment — matches detected faces to this user's persons
        if (!job.user_id) break; // should never happen, but guard
        await assignFacesForUser(job.user_id, job.photo_id, job.force);
        break;
      case "landmark":
        await indexPhotoLandmarks(job.photo_id);
        break;
      case "quality":
        await indexPhotoQuality(job.photo_id);
        break;
      case "geocoding":
        await indexPhotoGeocoding(job.photo_id, job.force);
        // Respect Nominatim rate limit (1 req/s)
        await new Promise((r) => setTimeout(r, 1100));
        break;
      case "thumbnail":
        await indexPhotoThumbnails(job.photo_id);
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

  /** Number of jobs currently being processed by this worker. */
  inFlight(): number {
    return this.running;
  }
}

/**
 * Worker for external-library scans. Runs one job at a time (filesystem
 * walks are I/O-bound and already parallelise internally via individual
 * file imports). Each job calls scanLibrary(), optionally preceded by
 * reconcileLibrary() when the enqueuing code asked for it.
 *
 * The worker shares the same pause / shutdown lifecycle as the per-photo
 * ScanWorkers so backups see a quiet queue.
 */
class LibraryScanWorker {
  private running = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  readonly service = "library_scan" as const;
  readonly concurrency = 1;

  tick(): void {
    while (this.running < this.concurrency) {
      this.running++;
      this.processNext()
        .then((hadWork) => {
          this.running--;
          if (hadWork && this.running < this.concurrency) {
            const level = getPressureLevel();
            const delay = level === "hard"
              ? WORKER_HARD_PRESSURE_DELAY_MS
              : level === "soft"
                ? WORKER_PRESSURE_DELAY_MS
                : 0;
            setTimeout(() => this.tick(), delay);
          }
        })
        .catch(() => {
          this.running--;
        });
    }
  }

  private async processNext(): Promise<boolean> {
    if (workersPaused) return false;
    // library_scan is the heaviest job in the system (walks a whole tree
    // and triggers dozens of sub-enqueues). Pause even under soft pressure.
    if (isUnderSoftPressure()) return false;

    const job = await dequeueNextLibraryScan();
    if (!job) return false;

    try {
      // Dynamic import breaks the scan-worker ↔ libraries.service cycle
      // (libraries.service imports triggerWorkers from here).
      const libs = await import("./libraries.service");
      let removed: number | null = null;
      if (job.reconcile) {
        const r = await libs.reconcileLibrary(job.library_id);
        removed = r.removed;
      }
      const report = await libs.scanLibrary(job.library_id, job.id);
      await markLibraryScanDone(job.id, report, removed);
    } catch (err: any) {
      if (err?.name === "ScanCancelledError") {
        // User-triggered cancel via Datenverwaltung. Mark as failed so the
        // row leaves 'processing' and the UI's "wird abgebrochen…" hint
        // clears; a clear message keeps it distinguishable from real errors.
        console.log(`[scan-worker] library_scan job ${job.id} cancelled by user`);
        await markLibraryScanFailed(job.id, "Scan vom Benutzer abgebrochen").catch(() => {});
      } else {
        const msg = err?.message ?? String(err);
        console.error(`[scan-worker] library_scan job ${job.id} failed:`, msg);
        await markLibraryScanFailed(job.id, msg).catch(() => {});
      }
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

  inFlight(): number {
    return this.running;
  }
}

const embeddingConcurrency = parseInt(process.env.SCAN_EMBEDDING_CONCURRENCY ?? "1", 10);
const faceConcurrency = parseInt(process.env.SCAN_FACE_CONCURRENCY ?? "1", 10);
const faceAssignConcurrency = parseInt(process.env.SCAN_FACE_ASSIGN_CONCURRENCY ?? "1", 10);
const landmarkConcurrency = parseInt(process.env.SCAN_LANDMARK_CONCURRENCY ?? "1", 10);
const qualityConcurrency = parseInt(process.env.SCAN_QUALITY_CONCURRENCY ?? "1", 10);
const thumbnailConcurrency = parseInt(process.env.SCAN_THUMBNAIL_CONCURRENCY ?? "1", 10);

const embeddingWorker = new ScanWorker("embedding", embeddingConcurrency);
const faceWorker = new ScanWorker("face_detection", faceConcurrency);
const faceAssignWorker = new ScanWorker("face_assignment", faceAssignConcurrency);
const landmarkWorker = new ScanWorker("landmark", landmarkConcurrency);
const qualityWorker = new ScanWorker("quality", qualityConcurrency);
const geocodingWorker = new ScanWorker("geocoding", 1); // always 1 — Nominatim rate limit
const thumbnailWorker = new ScanWorker("thumbnail", thumbnailConcurrency);
const libraryScanWorker = new LibraryScanWorker();

/** Wake all workers to check for new work. Non-blocking. */
export function triggerWorkers(): void {
  if (workersPaused) return;
  embeddingWorker.tick();
  faceWorker.tick();
  faceAssignWorker.tick();
  landmarkWorker.tick();
  qualityWorker.tick();
  geocodingWorker.tick();
  thumbnailWorker.tick();
  libraryScanWorker.tick();
}

/** Wake just the library-scan worker. Called after enqueueLibraryScan(). */
export function triggerLibraryScanWorker(): void {
  if (workersPaused) return;
  libraryScanWorker.tick();
}

const ALL_WORKERS: Array<{ stop(): void; start(): void; inFlight(): number }> = [
  embeddingWorker,
  faceWorker,
  faceAssignWorker,
  landmarkWorker,
  qualityWorker,
  geocodingWorker,
  thumbnailWorker,
  libraryScanWorker,
];

/**
 * Pause all scan workers. Sets the global flag, stops the poll timers, and
 * waits up to `drainTimeoutMs` for any in-flight jobs to finish so the
 * caller can enter pg_backup_start() with a quiet queue.
 *
 * If in-flight work does not drain within the timeout the function returns
 * anyway — the caller should treat that as a warning, not an error.
 */
export async function pauseWorkers(drainTimeoutMs = 60_000): Promise<void> {
  workersPaused = true;
  for (const w of ALL_WORKERS) w.stop();

  const start = Date.now();
  while (Date.now() - start < drainTimeoutMs) {
    const busy = ALL_WORKERS.some((w) => w.inFlight() > 0);
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Resume all scan workers after a pauseWorkers() call. Safe to call while running. */
export function resumeWorkers(): void {
  if (!workersPaused) return;
  workersPaused = false;
  for (const w of ALL_WORKERS) w.start();
}

export async function startWorkers(): Promise<void> {
  // Reset jobs that were stuck in 'processing' state when the server last stopped
  await resetStuckJobs();
  await resetStuckLibraryScans();

  // Start event-loop pressure monitor so workers can back off when
  // the server is exhausted, giving health checks priority.
  startPressureMonitor();

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
      // Also wake face_assignment — new detections may be available
      faceAssignWorker.tick();
    } else if (name === "landmark") {
      landmarkWorker.tick();
    }
  });

  console.log("[scan-worker] Workers starting...");
  embeddingWorker.start();
  faceWorker.start();
  faceAssignWorker.start();
  landmarkWorker.start();
  qualityWorker.start();
  geocodingWorker.start();
  thumbnailWorker.start();
  libraryScanWorker.start();
  console.log(
    `[scan-worker] embedding(c=${embeddingConcurrency}), face_detection(c=${faceConcurrency}), face_assignment(c=${faceAssignConcurrency}), landmark(c=${landmarkConcurrency}), quality(c=${qualityConcurrency}), geocoding(c=1), thumbnail(c=${thumbnailConcurrency}), library_scan(c=1)`,
  );
}

// Start workers immediately when this module is loaded
startWorkers().catch((err) => console.error("[scan-worker] Failed to start workers:", err));
