/**
 * Persistent scan queue helpers.
 * All DB operations for photo_scan_queue live here.
 *
 * Services are split into two categories:
 *   Global:   face_detection, embedding, landmark, quality, geocoding
 *             → run once per photo (user_id = NULL)
 *   Per-user: face_assignment
 *             → run once per user per photo (user_id set)
 */

import { eq, and, inArray, sql, not, isNull } from "drizzle-orm";
import db from "../db/database";
import { photoScanQueue, photos, faces, photoLandmarks } from "../db/schema";
import { ENABLE_LOCAL_FACES, ENABLE_LANDMARKS, ENABLE_QUALITY } from "./scan-config";

export type ScanService = "embedding" | "face_detection" | "face_assignment" | "landmark" | "quality" | "geocoding";
export type ScanStatus = "pending" | "processing" | "failed" | "done";

/**
 * Service identifiers surfaced in QueueStatus.services. Includes the
 * DB-backed ScanService values plus synthetic rows aggregated from other
 * queues (currently: library_scan).
 */
export type QueueServiceId = ScanService | "library_scan";

/** Services that run once per photo (no user_id in queue). */
const GLOBAL_SERVICES: ReadonlySet<ScanService> = new Set([
  "face_detection", "embedding", "landmark", "quality", "geocoding",
]);

/** Services that run once per user per photo. */
const PER_USER_SERVICES: ReadonlySet<ScanService> = new Set([
  "face_assignment",
]);

export function isGlobalService(service: ScanService): boolean {
  return GLOBAL_SERVICES.has(service);
}

/**
 * Thrown by a job handler to signal "not ready yet — put me back in the queue".
 * The worker resets the job to pending without counting it as a failed attempt.
 */
export class DeferJobError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DeferJobError";
  }
}

export interface QueueServiceStatus {
  service: QueueServiceId;
  pending: number;
  processing: number;
  failed: number;
  done: number;
}

export interface QueueStatus {
  services: QueueServiceStatus[];
}

/** Services that are enabled in this installation */
function enabledServices(): ScanService[] {
  const services: ScanService[] = ["embedding", "geocoding"];
  if (ENABLE_LOCAL_FACES) {
    services.push("face_detection");
    services.push("face_assignment");
  }
  if (ENABLE_LANDMARKS) services.push("landmark");
  if (ENABLE_QUALITY) services.push("quality");
  return services;
}

/**
 * Enqueue a photo for scanning across all enabled services.
 * Global services use user_id = NULL (one job per photo).
 * Per-user services use the provided userId.
 * Uses ON CONFLICT DO NOTHING so a photo already pending/processing is not duplicated.
 * If force=true the existing pending row is updated to set force=true.
 */
export async function enqueuePhotoScan(
  photoId: number,
  userId: number,
  services: ScanService[] = enabledServices(),
  force = false,
): Promise<void> {
  if (services.length === 0) return;

  for (const service of services) {
    const queueUserId = isGlobalService(service) ? null : userId;

    // Try insert first (covers the common case: new photo, not yet in queue)
    const result = await db
      .insert(photoScanQueue)
      .values({ photo_id: photoId, user_id: queueUserId, service, force })
      .onConflictDoNothing()
      .returning({ id: photoScanQueue.id });

    // If nothing was inserted (duplicate pending/processing), and force was requested,
    // upgrade the existing pending row to force=true
    if (result.length === 0 && force) {
      if (isGlobalService(service)) {
        await db
          .update(photoScanQueue)
          .set({ force: true })
          .where(
            and(
              eq(photoScanQueue.photo_id, photoId),
              eq(photoScanQueue.service, service),
              isNull(photoScanQueue.user_id),
              inArray(photoScanQueue.status, ["pending", "processing"]),
            ),
          );
      } else {
        await db
          .update(photoScanQueue)
          .set({ force: true })
          .where(
            and(
              eq(photoScanQueue.photo_id, photoId),
              eq(photoScanQueue.service, service),
              eq(photoScanQueue.user_id, userId),
              inArray(photoScanQueue.status, ["pending", "processing"]),
            ),
          );
      }
    }
  }
}

/**
 * Atomically claim the next pending job for a service.
 * Uses FOR UPDATE SKIP LOCKED so multiple workers don't race.
 * Returns the claimed row or undefined if queue is empty.
 */
export async function dequeueNextJob(service: ScanService): Promise<typeof photoScanQueue.$inferSelect | undefined> {
  const rows = await db.execute<typeof photoScanQueue.$inferSelect>(sql`
    UPDATE photo_scan_queue
    SET status = 'processing',
        started_at = NOW(),
        attempts = attempts + 1
    WHERE id = (
      SELECT id FROM photo_scan_queue
      WHERE service = ${service}
        AND status = 'pending'
      ORDER BY enqueued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  return rows.rows[0];
}

export async function markJobDone(id: number): Promise<void> {
  await db
    .update(photoScanQueue)
    .set({ status: "done", finished_at: sql`NOW()` })
    .where(eq(photoScanQueue.id, id));
}

/**
 * Reset a processing job back to pending without incrementing the attempt
 * counter.  Used when a job cannot run yet because a prerequisite scan has
 * not finished — the job will be retried on the next worker poll cycle.
 *
 * enqueued_at is bumped to NOW() so the deferred job moves to the back of
 * the queue and doesn't block other ready jobs (prevents livelock).
 */
export async function deferJob(id: number): Promise<void> {
  await db
    .update(photoScanQueue)
    .set({
      status: "pending",
      started_at: null,
      enqueued_at: sql`NOW()`,
      attempts: sql`GREATEST(0, attempts - 1)`,
    })
    .where(eq(photoScanQueue.id, id));
}

export async function markJobFailed(id: number, error: string): Promise<void> {
  await db
    .update(photoScanQueue)
    .set({ status: "failed", error_msg: error, finished_at: sql`NOW()` })
    .where(eq(photoScanQueue.id, id));
}

/**
 * Aggregate queue counts for a user.
 * Global services: only count rows where user_id IS NULL (avoids double-counting legacy rows).
 * Per-user services: only count rows where user_id = userId.
 */
export async function getQueueStatus(userId: number): Promise<QueueStatus> {
  const rows = await db.execute<{ service: ScanService; status: ScanStatus; count: string }>(sql`
    SELECT service, status, COUNT(*)::int as count
    FROM photo_scan_queue
    WHERE (user_id IS NULL AND service IN ('face_detection', 'embedding', 'landmark', 'quality', 'geocoding'))
       OR (user_id = ${userId} AND service = 'face_assignment')
    GROUP BY service, status
  `);

  const map = new Map<QueueServiceId, QueueServiceStatus>();
  for (const svc of (["embedding", "face_detection", "face_assignment", "landmark", "quality", "geocoding"] as ScanService[])) {
    map.set(svc, { service: svc, pending: 0, processing: 0, failed: 0, done: 0 });
  }

  for (const row of rows.rows) {
    const entry = map.get(row.service);
    if (entry) {
      entry[row.status] = Number(row.count);
    }
  }

  // Library scans live in their own table but are surfaced as just another
  // row in the same status table so the admin sees the complete picture.
  const libRows = await db.execute<{ status: ScanStatus; count: string }>(sql`
    SELECT status, COUNT(*)::int as count
    FROM library_scan_queue
    GROUP BY status
  `);
  const libEntry: QueueServiceStatus = {
    service: "library_scan",
    pending: 0,
    processing: 0,
    failed: 0,
    done: 0,
  };
  for (const row of libRows.rows) {
    libEntry[row.status] = Number(row.count);
  }
  map.set("library_scan", libEntry);

  return { services: Array.from(map.values()) };
}

/** Reset all failed jobs for a user back to pending. */
export async function requeueFailed(userId: number): Promise<number> {
  // Reset per-user failed jobs
  const perUserResult = await db
    .update(photoScanQueue)
    .set({ status: "pending", error_msg: null, started_at: null, finished_at: null })
    .where(and(eq(photoScanQueue.user_id, userId), eq(photoScanQueue.status, "failed")));

  // Reset global failed jobs for this user's photos
  const globalResult = await db.execute(sql`
    UPDATE photo_scan_queue
    SET status = 'pending', error_msg = NULL, started_at = NULL, finished_at = NULL
    WHERE status = 'failed'
      AND user_id IS NULL
      AND photo_id IN (SELECT id FROM photos WHERE user_id = ${userId})
  `);

  return ((perUserResult as any).rowCount ?? 0) + ((globalResult as any).rowCount ?? 0);
}

/**
 * Enqueue photos for re-scanning.
 * force=false: only photos that are missing scan data for each service.
 * force=true:  all photos; existing done/failed rows are reset to pending.
 */
export async function requeueForRescan(userId: number, force: boolean): Promise<number> {
  const services = enabledServices();
  let queued = 0;

  for (const service of services) {
    let photoIds: number[];

    if (!force) {
      // Only photos with missing scan data for this service
      photoIds = await getMissingPhotoIds(userId, service);
    } else {
      // All photos for this user
      const rows = await db
        .select({ id: photos.id })
        .from(photos)
        .where(eq(photos.user_id, userId));
      photoIds = rows.map((r) => r.id);
    }

    const isGlobal = isGlobalService(service);

    for (const photoId of photoIds) {
      if (force) {
        // Remove all done/failed rows first so at most one row (the active one)
        // remains. Without this, updating multiple rows to 'pending' would
        // violate the partial unique index.
        if (isGlobal) {
          // Delete ALL non-active rows for this photo+service, including legacy
          // rows that still have user_id set from before the global migration.
          await db
            .delete(photoScanQueue)
            .where(
              and(
                eq(photoScanQueue.photo_id, photoId),
                eq(photoScanQueue.service, service),
                not(inArray(photoScanQueue.status, ["pending", "processing"])),
              ),
            );
          // Also delete legacy rows with user_id that are active (shouldn't happen
          // normally, but cleans up any stuck legacy entries).
          await db.execute(sql`
            DELETE FROM photo_scan_queue
            WHERE photo_id = ${photoId}
              AND service = ${service}
              AND user_id IS NOT NULL
          `);

          const updated = await db
            .update(photoScanQueue)
            .set({ status: "pending", force: true, error_msg: null, started_at: null, finished_at: null, attempts: 0 })
            .where(
              and(eq(photoScanQueue.photo_id, photoId), eq(photoScanQueue.service, service), isNull(photoScanQueue.user_id)),
            );
          if (((updated as any).rowCount ?? 0) === 0) {
            await db
              .insert(photoScanQueue)
              .values({ photo_id: photoId, user_id: null, service, force: true })
              .onConflictDoNothing();
          }
        } else {
          await db
            .delete(photoScanQueue)
            .where(
              and(
                eq(photoScanQueue.photo_id, photoId),
                eq(photoScanQueue.service, service),
                eq(photoScanQueue.user_id, userId),
                not(inArray(photoScanQueue.status, ["pending", "processing"])),
              ),
            );

          const updated = await db
            .update(photoScanQueue)
            .set({ status: "pending", force: true, error_msg: null, started_at: null, finished_at: null, attempts: 0 })
            .where(
              and(eq(photoScanQueue.photo_id, photoId), eq(photoScanQueue.service, service), eq(photoScanQueue.user_id, userId)),
            );
          if (((updated as any).rowCount ?? 0) === 0) {
            await db
              .insert(photoScanQueue)
              .values({ photo_id: photoId, user_id: userId, service, force: true })
              .onConflictDoNothing();
          }
        }
      } else {
        // Remove old done/failed rows so the counter stays accurate
        if (isGlobal) {
          // Delete ALL non-active rows including legacy per-user entries
          await db
            .delete(photoScanQueue)
            .where(
              and(
                eq(photoScanQueue.photo_id, photoId),
                eq(photoScanQueue.service, service),
                not(inArray(photoScanQueue.status, ["pending", "processing"])),
              ),
            );
          // Also delete legacy rows with user_id
          await db.execute(sql`
            DELETE FROM photo_scan_queue
            WHERE photo_id = ${photoId}
              AND service = ${service}
              AND user_id IS NOT NULL
          `);
          await db
            .insert(photoScanQueue)
            .values({ photo_id: photoId, user_id: null, service, force: false })
            .onConflictDoNothing();
        } else {
          await db
            .delete(photoScanQueue)
            .where(
              and(
                eq(photoScanQueue.photo_id, photoId),
                eq(photoScanQueue.service, service),
                eq(photoScanQueue.user_id, userId),
                not(inArray(photoScanQueue.status, ["pending", "processing"])),
              ),
            );
          await db
            .insert(photoScanQueue)
            .values({ photo_id: photoId, user_id: userId, service, force: false })
            .onConflictDoNothing();
        }
      }
      queued++;
    }
  }

  return queued;
}

async function getMissingPhotoIds(userId: number, service: ScanService): Promise<number[]> {
  if (isGlobalService(service)) {
    // Global services: photos owned by this user that don't have a 'done' queue entry.
    // Accepts both new global rows (user_id IS NULL) and legacy per-user rows as "done".
    const rows = await db.execute<{ id: number }>(sql`
      SELECT p.id FROM photos p
      WHERE p.user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM photo_scan_queue q
          WHERE q.photo_id = p.id
            AND q.service = ${service}
            AND q.status = 'done'
        )
    `);
    return rows.rows.map((r) => r.id);
  }

  if (service === "face_assignment") {
    // Per-user: photos that have been detected but not yet assigned for this user.
    const rows = await db.execute<{ id: number }>(sql`
      SELECT p.id FROM photos p
      WHERE p.user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM photo_scan_queue q
          WHERE q.photo_id = p.id
            AND q.user_id = ${userId}
            AND q.service = 'face_assignment'
            AND q.status = 'done'
        )
    `);
    return rows.rows.map((r) => r.id);
  }

  // Fallback (shouldn't reach here)
  return [];
}

/**
 * Cancel all pending scan jobs for a user.
 * Cancels per-user jobs and global jobs for the user's photos.
 * Processing jobs are left alone (they will finish their current work).
 * Returns the number of cancelled jobs.
 */
export async function cancelPendingScans(userId: number): Promise<number> {
  // Cancel per-user pending jobs
  const perUserResult = await db
    .delete(photoScanQueue)
    .where(and(eq(photoScanQueue.user_id, userId), eq(photoScanQueue.status, "pending")));

  // Cancel global pending jobs for this user's photos
  const globalResult = await db.execute(sql`
    DELETE FROM photo_scan_queue
    WHERE status = 'pending'
      AND user_id IS NULL
      AND photo_id IN (SELECT id FROM photos WHERE user_id = ${userId})
  `);

  return ((perUserResult as any).rowCount ?? 0) + ((globalResult as any).rowCount ?? 0);
}

/**
 * Reset stuck 'processing' jobs back to 'pending' on service restart.
 * Called once at worker boot time.
 */
export async function resetStuckJobs(): Promise<void> {
  await db
    .update(photoScanQueue)
    .set({ status: "pending", started_at: null })
    .where(eq(photoScanQueue.status, "processing"));
}
