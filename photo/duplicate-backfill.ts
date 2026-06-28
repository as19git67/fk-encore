import { and, eq, inArray, lte, sql } from "drizzle-orm";
import db from "../db/database";
import { photoDuplicateBackfillState, photoScanQueue } from "../db/schema";
import { isUnderSoftPressure } from "./event-loop-pressure";
import { scheduleRegroup } from "./photo.service";

export const DUPLICATE_BACKFILL_VERSION = 1;
const CLAIM_TIMEOUT_MINUTES = 30;

export interface DuplicateBackfillResult {
  status: "deferred" | "processed" | "complete";
  user_id: number | null;
  reason?: "system_busy" | "retry_backoff";
}

async function systemHasForegroundWork(): Promise<boolean> {
  if (isUnderSoftPressure()) return true;
  const rows = await db
    .select({ id: photoScanQueue.id })
    .from(photoScanQueue)
    .where(and(
      inArray(photoScanQueue.status, ["pending", "processing"]),
      lte(photoScanQueue.priority, 1),
    ))
    .limit(1);
  return rows.length > 0;
}

/**
 * Process at most one user's existing library. The expensive operation is
 * deliberately outside the claim transaction; `processing_at` is a lease so
 * another container can recover the user after a crash or restart.
 */
export async function runDuplicateBackfillBatch(): Promise<DuplicateBackfillResult> {
  if (await systemHasForegroundWork()) {
    return { status: "deferred", user_id: null, reason: "system_busy" };
  }

  // Seed checkpoints for both existing and newly-created users. Completed
  // installations pay only this idempotent INSERT + the empty claim below.
  await db.execute(sql`
    INSERT INTO photo_duplicate_backfill_state (user_id)
    SELECT id FROM users
    ON CONFLICT (user_id) DO NOTHING
  `);

  const claimed = await db.execute<{ user_id: number }>(sql`
    UPDATE photo_duplicate_backfill_state
    SET processing_at = NOW(),
        attempts = attempts + 1,
        last_error = NULL,
        updated_at = NOW()
    WHERE user_id = (
      SELECT user_id
      FROM photo_duplicate_backfill_state
      WHERE version < ${DUPLICATE_BACKFILL_VERSION}
        AND (
          processing_at IS NULL
          OR processing_at < NOW() - (${CLAIM_TIMEOUT_MINUTES} * INTERVAL '1 minute')
        )
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY user_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING user_id
  `);
  const userId = claimed.rows[0]?.user_id;
  if (userId == null) {
    const unfinished = await db
      .select({ user_id: photoDuplicateBackfillState.user_id })
      .from(photoDuplicateBackfillState)
      .where(lte(photoDuplicateBackfillState.version, DUPLICATE_BACKFILL_VERSION - 1))
      .limit(1);
    return unfinished.length > 0
      ? { status: "deferred", user_id: null, reason: "retry_backoff" }
      : { status: "complete", user_id: null };
  }

  try {
    // This reuses persisted DINO embeddings; no original image decode or new
    // embedding calculation is performed by the backfill itself.
    await scheduleRegroup(userId);
    await db
      .update(photoDuplicateBackfillState)
      .set({
        version: DUPLICATE_BACKFILL_VERSION,
        processing_at: null,
        completed_at: sql`NOW()`,
        next_attempt_at: null,
        last_error: null,
        updated_at: sql`NOW()`,
      })
      .where(eq(photoDuplicateBackfillState.user_id, userId));
    return { status: "processed", user_id: userId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(photoDuplicateBackfillState)
      .set({
        processing_at: null,
        next_attempt_at: sql`NOW() + INTERVAL '30 minutes'`,
        last_error: message.slice(0, 2000),
        updated_at: sql`NOW()`,
      })
      .where(eq(photoDuplicateBackfillState.user_id, userId));
    throw err;
  }
}
