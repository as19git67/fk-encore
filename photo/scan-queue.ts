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
import { ENABLE_LOCAL_FACES, ENABLE_POI_DETECTION, ENABLE_QUALITY, ENABLE_THUMBNAIL_PREWARM } from "./scan-config";
import { notifyScanQueueChanged } from "./scan-queue-events";

// `landmark` is retained in the type union and GLOBAL_SERVICES set so
// pre-existing rows in `photo_scan_queue` (and the `scan_service`
// postgres enum) remain valid. Production no longer enqueues new
// landmark jobs — the Grounding-DINO worker has been retired in favour
// of osm-admin POI detection (Epic #383). See ENABLE_LANDMARKS comment
// in scan-config.ts.
export type ScanService = "embedding" | "face_detection" | "face_assignment" | "landmark" | "quality" | "geocoding" | "thumbnail" | "poi_detection";
export type ScanStatus = "pending" | "processing" | "failed" | "done";

/** Every value of the `scan_service` enum, for runtime validation of
 *  untrusted input (e.g. a `service` query parameter). */
export const ALL_SCAN_SERVICES: readonly ScanService[] = [
  "embedding", "face_detection", "face_assignment", "landmark",
  "quality", "geocoding", "thumbnail", "poi_detection",
];

export function isScanService(value: string): value is ScanService {
  return (ALL_SCAN_SERVICES as readonly string[]).includes(value);
}

export type QueueServiceId = ScanService;

/** Services that run once per photo (no user_id in queue). */
const GLOBAL_SERVICES: ReadonlySet<ScanService> = new Set([
  "face_detection", "embedding", "landmark", "quality", "geocoding", "thumbnail", "poi_detection",
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

/**
 * Live counters for an in-flight library_scan job. Only set when the
 * library_scan row is currently 'processing'; the per-photo services
 * don't carry per-row progress, so this stays optional.
 */
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
  // `landmark` (Grounding DINO) is retired — see scan-config.ts.
  if (ENABLE_POI_DETECTION) services.push("poi_detection");
  if (ENABLE_QUALITY) services.push("quality");
  if (ENABLE_THUMBNAIL_PREWARM) services.push("thumbnail");
  return services;
}

/**
 * Enqueue a photo for scanning across all enabled services.
 * Global services use user_id = NULL (one job per photo).
 * Per-user services use the provided userId.
 * Uses ON CONFLICT DO NOTHING so a photo already pending/processing is not duplicated.
 * If force=true the existing pending row is updated to set force=true.
 *
 * Priority convention (lower wins, see dequeueNextJob ORDER BY):
 *   1 — fresh user-driven uploads / interactive re-scans
 *   2 — default background work (library imports, share fan-out)
 *   3 — failed / requeued / bulk backfills
 */
export async function enqueuePhotoScan(
  photoId: number,
  userId: number,
  services: ScanService[] = enabledServices(),
  force = false,
  priority = 2,
): Promise<void> {
  if (services.length === 0) return;
  notifyScanQueueChanged();

  for (const service of services) {
    const queueUserId = isGlobalService(service) ? null : userId;

    // Try insert first (covers the common case: new photo, not yet in queue)
    const result = await db
      .insert(photoScanQueue)
      .values({ photo_id: photoId, user_id: queueUserId, service, force, priority })
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
 * Enqueue the same (photoId, service) for many users in a single INSERT.
 *
 * Replaces the pattern `Promise.all(users.map(id => enqueuePhotoScan(..)))`
 * which would hit the DB N times and issue N client/pool round-trips. One
 * bulk insert keeps fan-out cheap even for albums shared with hundreds of
 * users.
 *
 * Only makes sense for per-user services (face_assignment). Global services
 * should use enqueuePhotoScan() directly — they have at most one row per
 * photo, so there is no fan-out to batch.
 */
export async function enqueuePhotoScanBulkPerUser(
  photoId: number,
  userIds: number[],
  service: ScanService,
  force = false,
  priority = 2,
): Promise<void> {
  if (userIds.length === 0) return;
  if (isGlobalService(service)) {
    throw new Error(`enqueuePhotoScanBulkPerUser cannot be used for global service '${service}'`);
  }
  notifyScanQueueChanged();

  const rows = userIds.map((user_id) => ({
    photo_id: photoId,
    user_id,
    service,
    force,
    priority,
  }));

  await db
    .insert(photoScanQueue)
    .values(rows)
    .onConflictDoNothing();

  if (force) {
    // Upgrade any already-pending duplicates to force=true so a rescan
    // actually re-runs. Cheap: one UPDATE regardless of userIds length.
    await db
      .update(photoScanQueue)
      .set({ force: true })
      .where(
        and(
          eq(photoScanQueue.photo_id, photoId),
          eq(photoScanQueue.service, service),
          inArray(photoScanQueue.user_id, userIds),
          inArray(photoScanQueue.status, ["pending", "processing"]),
        ),
      );
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
      ORDER BY priority ASC, enqueued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  if (rows.rows[0]) notifyScanQueueChanged();
  return rows.rows[0];
}

export async function markJobDone(id: number): Promise<void> {
  await db
    .update(photoScanQueue)
    .set({ status: "done", finished_at: sql`NOW()` })
    .where(eq(photoScanQueue.id, id));
  notifyScanQueueChanged();
}

/**
 * True when an `embedding` job for this photo is still pending or processing.
 * `poi_detection` needs the photo's embedding; on a fresh manual upload both
 * are enqueued at the same priority, so poi_detection can dequeue first and
 * find no embedding yet. The worker uses this to decide whether to DEFER
 * poi_detection (retry once embedding lands) or give up — deferring forever
 * would livelock if the embedding had permanently failed.
 */
export async function hasActiveEmbeddingJob(photoId: number): Promise<boolean> {
  const rows = await db
    .select({ id: photoScanQueue.id })
    .from(photoScanQueue)
    .where(
      and(
        eq(photoScanQueue.photo_id, photoId),
        eq(photoScanQueue.service, "embedding"),
        inArray(photoScanQueue.status, ["pending", "processing"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
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
  notifyScanQueueChanged();
}

export async function markJobFailed(id: number, error: string): Promise<void> {
  await db
    .update(photoScanQueue)
    .set({ status: "failed", error_msg: error, finished_at: sql`NOW()` })
    .where(eq(photoScanQueue.id, id));
  notifyScanQueueChanged();
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
    WHERE (user_id IS NULL AND service IN ('face_detection', 'embedding', 'landmark', 'quality', 'geocoding', 'thumbnail', 'poi_detection'))
       OR (user_id = ${userId} AND service = 'face_assignment')
    GROUP BY service, status
  `);

  const map = new Map<QueueServiceId, QueueServiceStatus>();
  for (const svc of (["embedding", "face_detection", "face_assignment", "landmark", "quality", "geocoding", "thumbnail", "poi_detection"] as ScanService[])) {
    map.set(svc, { service: svc, pending: 0, processing: 0, failed: 0, done: 0 });
  }

  for (const row of rows.rows) {
    const entry = map.get(row.service);
    if (entry) {
      entry[row.status] = Number(row.count);
    }
  }

  return { services: Array.from(map.values()) };
}

/** One row of the failed-jobs breakdown: identical error messages
 *  collapsed into a single group. */
export interface FailedJobGroup {
  /** The shared `error_msg`, or "(no message)" when the column is null. */
  errorMsg: string;
  /** Number of failed jobs that carry this exact message. */
  count: number;
  /** Up to 10 representative photo ids (most-recently-failed first). */
  samplePhotoIds: number[];
  /** Timestamp of the most recent failure in this group (ISO string). */
  lastFailedAt: string | null;
}

/**
 * Failed jobs for one service, grouped by error message.
 *
 * Applies the same user-scoping rule as `getQueueStatus`: global
 * services are counted over `user_id IS NULL`, the per-user
 * `face_assignment` service over `user_id = userId`. Without that
 * split an admin would see other users' face_assignment failures (or
 * miss their own).
 */
export async function getFailedJobsGrouped(
  userId: number,
  service: ScanService,
): Promise<FailedJobGroup[]> {
  const userScope = isGlobalService(service)
    ? sql`${photoScanQueue.user_id} IS NULL`
    : sql`${photoScanQueue.user_id} = ${userId}`;

  const rows = await db.execute<{
    error_msg: string;
    count: number;
    sample_photo_ids: number[];
    last_failed_at: string | null;
  }>(sql`
    SELECT
      COALESCE(error_msg, '(no message)')                       AS error_msg,
      COUNT(*)::int                                             AS count,
      (array_agg(photo_id ORDER BY finished_at DESC NULLS LAST))[1:10]
                                                                AS sample_photo_ids,
      MAX(finished_at)                                          AS last_failed_at
    FROM photo_scan_queue
    WHERE service = ${service}
      AND status = 'failed'
      AND ${userScope}
    GROUP BY COALESCE(error_msg, '(no message)')
    ORDER BY count DESC
  `);

  return rows.rows.map((r) => ({
    errorMsg: r.error_msg,
    count: Number(r.count),
    samplePhotoIds: (r.sample_photo_ids ?? []).map(Number),
    lastFailedAt: r.last_failed_at,
  }));
}

/**
 * Backfill `poi_detection` jobs for every photo whose GPS falls in
 * the given bounding box. Used by the osm-admin importer when a
 * region transitions to `ready_running`, so photos that were
 * previously dropped with `no_region` get a fresh shot at being
 * matched against the newly-available regional PostGIS database.
 *
 * Steps:
 *   1. Delete any `done`/`failed` poi_detection rows for those
 *      photos so they can be re-enqueued.
 *   2. Insert pending rows for each. The partial unique index on
 *      `(photo_id, service) WHERE status IN ('pending','processing')`
 *      collapses concurrent inserts via ON CONFLICT DO NOTHING.
 *
 * Returns the number of pending rows actually inserted.
 */
export async function enqueuePoiDetectionForRegion(bbox: {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}): Promise<number> {
  // Drop terminal rows so the partial unique index lets us insert
  // fresh `pending` ones.
  await db.execute(sql`
    DELETE FROM photo_scan_queue
    WHERE service = 'poi_detection'
      AND status IN ('done', 'failed')
      AND user_id IS NULL
      AND photo_id IN (
        SELECT id FROM photos
        WHERE latitude  BETWEEN ${bbox.minLat} AND ${bbox.maxLat}
          AND longitude BETWEEN ${bbox.minLon} AND ${bbox.maxLon}
      )
  `);

  const insertResult = await db.execute(sql`
    INSERT INTO photo_scan_queue (photo_id, user_id, service, status, priority, force)
    SELECT p.id, NULL, 'poi_detection', 'pending', 3, false
    FROM photos p
    WHERE p.latitude  BETWEEN ${bbox.minLat} AND ${bbox.maxLat}
      AND p.longitude BETWEEN ${bbox.minLon} AND ${bbox.maxLon}
    ON CONFLICT DO NOTHING
  `);

  const enqueued = (insertResult as { rowCount?: number }).rowCount ?? 0;
  if (enqueued > 0) notifyScanQueueChanged();
  return enqueued;
}

/** Reset all failed jobs for a user back to pending (low priority). */
export async function requeueFailed(userId: number): Promise<number> {
  // Reset per-user failed jobs
  const perUserResult = await db
    .update(photoScanQueue)
    .set({ status: "pending", priority: 3, error_msg: null, started_at: null, finished_at: null })
    .where(and(eq(photoScanQueue.user_id, userId), eq(photoScanQueue.status, "failed")));

  // Reset global failed jobs for this user's photos
  const globalResult = await db.execute(sql`
    UPDATE photo_scan_queue
    SET status = 'pending', priority = 3, error_msg = NULL, started_at = NULL, finished_at = NULL
    WHERE status = 'failed'
      AND user_id IS NULL
      AND photo_id IN (SELECT id FROM photos WHERE user_id = ${userId})
  `);

  const changed = ((perUserResult as any).rowCount ?? 0) + ((globalResult as any).rowCount ?? 0);
  if (changed > 0) notifyScanQueueChanged();
  return changed;
}

/**
 * Enqueue photos for re-scanning.
 * force=false: only photos that are missing scan data for each service.
 * force=true:  all photos; existing done/failed rows are reset to pending.
 */
export async function requeueForRescan(userId: number, force: boolean): Promise<number> {
  const services = enabledServices();
  let queued = 0;
  notifyScanQueueChanged();

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
            .set({ status: "pending", force: true, priority: 3, error_msg: null, started_at: null, finished_at: null, attempts: 0 })
            .where(
              and(eq(photoScanQueue.photo_id, photoId), eq(photoScanQueue.service, service), isNull(photoScanQueue.user_id)),
            );
          if (((updated as any).rowCount ?? 0) === 0) {
            await db
              .insert(photoScanQueue)
              .values({ photo_id: photoId, user_id: null, service, force: true, priority: 3 })
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
            .set({ status: "pending", force: true, priority: 3, error_msg: null, started_at: null, finished_at: null, attempts: 0 })
            .where(
              and(eq(photoScanQueue.photo_id, photoId), eq(photoScanQueue.service, service), eq(photoScanQueue.user_id, userId)),
            );
          if (((updated as any).rowCount ?? 0) === 0) {
            await db
              .insert(photoScanQueue)
              .values({ photo_id: photoId, user_id: userId, service, force: true, priority: 3 })
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
            .values({ photo_id: photoId, user_id: null, service, force: false, priority: 3 })
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
            .values({ photo_id: photoId, user_id: userId, service, force: false, priority: 3 })
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

  const cancelled = ((perUserResult as any).rowCount ?? 0) + ((globalResult as any).rowCount ?? 0);
  if (cancelled > 0) notifyScanQueueChanged();
  return cancelled;
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
  notifyScanQueueChanged();
}
