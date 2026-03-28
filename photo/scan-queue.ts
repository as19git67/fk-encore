/**
 * Persistent scan queue helpers.
 * All DB operations for photo_scan_queue live here.
 */

import { eq, and, inArray, sql, not } from "drizzle-orm";
import db from "../db/database";
import { photoScanQueue, photos, faces, photoLandmarks } from "../db/schema";
import { ENABLE_LOCAL_FACES, ENABLE_LANDMARKS } from "./photo.service";

export type ScanService = "embedding" | "face_detection" | "landmark";
export type ScanStatus = "pending" | "processing" | "failed" | "done";

export interface QueueServiceStatus {
  service: ScanService;
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
  const services: ScanService[] = ["embedding"];
  if (ENABLE_LOCAL_FACES) services.push("face_detection");
  if (ENABLE_LANDMARKS) services.push("landmark");
  return services;
}

/**
 * Enqueue a photo for scanning across all enabled services.
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
    // Try insert first (covers the common case: new photo, not yet in queue)
    const result = await db
      .insert(photoScanQueue)
      .values({ photo_id: photoId, user_id: userId, service, force })
      .onConflictDoNothing()
      .returning({ id: photoScanQueue.id });

    // If nothing was inserted (duplicate pending/processing), and force was requested,
    // upgrade the existing pending row to force=true
    if (result.length === 0 && force) {
      await db
        .update(photoScanQueue)
        .set({ force: true })
        .where(
          and(
            eq(photoScanQueue.photo_id, photoId),
            eq(photoScanQueue.service, service),
            inArray(photoScanQueue.status, ["pending", "processing"]),
          ),
        );
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

export async function markJobFailed(id: number, error: string): Promise<void> {
  await db
    .update(photoScanQueue)
    .set({ status: "failed", error_msg: error, finished_at: sql`NOW()` })
    .where(eq(photoScanQueue.id, id));
}

/** Aggregate queue counts per service for a specific user. */
export async function getQueueStatus(userId: number): Promise<QueueStatus> {
  const rows = await db.execute<{ service: ScanService; status: ScanStatus; count: string }>(sql`
    SELECT service, status, COUNT(*)::int as count
    FROM photo_scan_queue
    WHERE user_id = ${userId}
    GROUP BY service, status
  `);

  const map = new Map<ScanService, QueueServiceStatus>();
  for (const svc of (["embedding", "face_detection", "landmark"] as ScanService[])) {
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

/** Reset all failed jobs for a user back to pending. */
export async function requeueFailed(userId: number): Promise<number> {
  const result = await db
    .update(photoScanQueue)
    .set({ status: "pending", error_msg: null, started_at: null, finished_at: null })
    .where(and(eq(photoScanQueue.user_id, userId), eq(photoScanQueue.status, "failed")));
  return (result as any).rowCount ?? 0;
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

    for (const photoId of photoIds) {
      if (force) {
        // Reset any existing row (pending/processing/failed/done) to pending with force=true
        const updated = await db
          .update(photoScanQueue)
          .set({ status: "pending", force: true, error_msg: null, started_at: null, finished_at: null, attempts: 0 })
          .where(
            and(eq(photoScanQueue.photo_id, photoId), eq(photoScanQueue.service, service)),
          );
        // No existing row → insert fresh
        if (((updated as any).rowCount ?? 0) === 0) {
          await db
            .insert(photoScanQueue)
            .values({ photo_id: photoId, user_id: userId, service, force: true })
            .onConflictDoNothing();
        }
      } else {
        await db
          .insert(photoScanQueue)
          .values({ photo_id: photoId, user_id: userId, service, force: false })
          .onConflictDoNothing();
      }
      queued++;
    }
  }

  return queued;
}

async function getMissingPhotoIds(userId: number, service: ScanService): Promise<number[]> {
  if (service === "face_detection") {
    // Photos with no face rows
    const rows = await db.execute<{ id: number }>(sql`
      SELECT p.id FROM photos p
      WHERE p.user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM faces f WHERE f.photo_id = p.id
        )
    `);
    return rows.rows.map((r) => r.id);
  }

  if (service === "landmark") {
    // Photos with no landmark rows
    const rows = await db.execute<{ id: number }>(sql`
      SELECT p.id FROM photos p
      WHERE p.user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM photo_landmarks l WHERE l.photo_id = p.id
        )
    `);
    return rows.rows.map((r) => r.id);
  }

  // embedding: photos without a 'done' queue entry (no confirmed successful embedding)
  const rows = await db.execute<{ id: number }>(sql`
    SELECT p.id FROM photos p
    WHERE p.user_id = ${userId}
      AND NOT EXISTS (
        SELECT 1 FROM photo_scan_queue q
        WHERE q.photo_id = p.id
          AND q.service = 'embedding'
          AND q.status = 'done'
      )
  `);
  return rows.rows.map((r) => r.id);
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
