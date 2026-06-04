import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import db from '../db/database'
import { photos, photoScanQueue, users } from '../db/schema'
import { enqueuePoiDetectionForMissingMatches } from './scan-queue'

/**
 * Targeted POI recovery for #558, made idempotent: re-enqueue poi_detection
 * only for the user's GPS photos whose poi_detection has NOT run since the
 * embedding finished. A photo already processed with its embedding present
 * (even with zero matches) must not be re-enqueued on every run.
 */
describe('enqueuePoiDetectionForMissingMatches', () => {
  let userId: number

  const EMB_DONE = '2026-01-01 10:00:00'
  const POI_BEFORE_EMB = '2026-01-01 09:00:00' // #558 footprint: poi ran first
  const POI_AFTER_EMB = '2026-01-01 11:00:00'  // correctly processed

  beforeEach(async () => {
    await db.delete(photoScanQueue)
    await db.delete(photos)
    await db.delete(users)
    const [u] = await db.insert(users).values({ email: 'poi@test.com', name: 'T', password_hash: 'x' }).returning({ id: users.id })
    userId = u.id
  })

  async function seedPhoto(gps: boolean, idx: number): Promise<number> {
    const [p] = await db.insert(photos).values({
      user_id: userId,
      filename: `p${idx}.jpg`,
      original_name: `p${idx}.jpg`,
      mime_type: 'image/jpeg',
      size: 1,
      latitude: gps ? 48.1 : null,
      longitude: gps ? 11.5 : null,
    }).returning({ id: photos.id })
    return p.id
  }

  async function queueRow(photoId: number, service: 'embedding' | 'poi_detection', finishedAt: string | null): Promise<void> {
    await db.insert(photoScanQueue).values({
      photo_id: photoId, user_id: null, service, status: 'done', priority: 2, finished_at: finishedAt,
    })
  }

  async function countPoi(photoId: number, status: 'pending' | 'done'): Promise<number> {
    const rows = await db.select({ id: photoScanQueue.id }).from(photoScanQueue).where(
      and(
        eq(photoScanQueue.photo_id, photoId),
        eq(photoScanQueue.service, 'poi_detection'),
        eq(photoScanQueue.status, status),
      ),
    )
    return rows.length
  }

  it('re-enqueues #558 footprint and never-processed photos, but not correctly-processed ones', async () => {
    // A: poi ran BEFORE embedding (the #558 race) → candidate
    const a = await seedPhoto(true, 1)
    await queueRow(a, 'embedding', EMB_DONE)
    await queueRow(a, 'poi_detection', POI_BEFORE_EMB)

    // B: poi ran AFTER embedding, zero matches → already processed → skip
    const b = await seedPhoto(true, 2)
    await queueRow(b, 'embedding', EMB_DONE)
    await queueRow(b, 'poi_detection', POI_AFTER_EMB)

    // C: embedding done, poi never ran → candidate
    const c = await seedPhoto(true, 3)
    await queueRow(c, 'embedding', EMB_DONE)

    const queued = await enqueuePoiDetectionForMissingMatches(userId)

    expect(queued).toBe(2)
    expect(await countPoi(a, 'pending')).toBe(1)
    expect(await countPoi(a, 'done')).toBe(0) // stale done replaced
    expect(await countPoi(c, 'pending')).toBe(1)
    // B is left untouched — no re-enqueue, its done row stays.
    expect(await countPoi(b, 'pending')).toBe(0)
    expect(await countPoi(b, 'done')).toBe(1)
  })

  it('is idempotent: a second run after processing enqueues nothing', async () => {
    // Photo that has been correctly processed (poi after embedding, no matches).
    const p = await seedPhoto(true, 1)
    await queueRow(p, 'embedding', EMB_DONE)
    await queueRow(p, 'poi_detection', POI_AFTER_EMB)

    const queued = await enqueuePoiDetectionForMissingMatches(userId)

    expect(queued).toBe(0)
    expect(await countPoi(p, 'pending')).toBe(0)
  })

  it('skips photos without GPS or without a finished embedding', async () => {
    const noGps = await seedPhoto(false, 1)
    await queueRow(noGps, 'embedding', EMB_DONE)

    const noEmbedding = await seedPhoto(true, 2)

    const queued = await enqueuePoiDetectionForMissingMatches(userId)

    expect(queued).toBe(0)
    expect(await countPoi(noGps, 'pending')).toBe(0)
    expect(await countPoi(noEmbedding, 'pending')).toBe(0)
  })
})
