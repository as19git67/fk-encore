import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import db from "../db/database";
import { photos, photoScanQueue, photoPoiMatches, users } from "../db/schema";
import { enqueuePoiDetectionForMissingMatches } from "./scan-queue";

/**
 * Targeted POI recovery for #558: re-enqueue poi_detection only for the user's
 * photos that have GPS + a finished embedding but no POI matches yet.
 */
describe("enqueuePoiDetectionForMissingMatches", () => {
  let userId: number;

  beforeEach(async () => {
    await db.delete(photoPoiMatches);
    await db.delete(photoScanQueue);
    await db.delete(photos);
    await db.delete(users);
    const [u] = await db.insert(users).values({ email: "poi@test.com", name: "T", password_hash: "x" }).returning({ id: users.id });
    userId = u.id;
  });

  async function seedPhoto(opts: { gps: boolean; idx: number }): Promise<number> {
    const [p] = await db.insert(photos).values({
      user_id: userId,
      filename: `p${opts.idx}.jpg`,
      original_name: `p${opts.idx}.jpg`,
      mime_type: "image/jpeg",
      size: 1,
      latitude: opts.gps ? 48.1 : null,
      longitude: opts.gps ? 11.5 : null,
    }).returning({ id: photos.id });
    return p.id;
  }

  async function setEmbeddingDone(photoId: number): Promise<void> {
    await db.insert(photoScanQueue).values({
      photo_id: photoId, user_id: null, service: "embedding", status: "done", priority: 2,
    });
  }

  async function pendingPoiRows(photoId: number): Promise<number> {
    const rows = await db.select({ id: photoScanQueue.id }).from(photoScanQueue).where(
      and(
        eq(photoScanQueue.photo_id, photoId),
        eq(photoScanQueue.service, "poi_detection"),
        eq(photoScanQueue.status, "pending"),
      ),
    );
    return rows.length;
  }

  it("re-enqueues a GPS photo with embedding done, no matches, and a stale done poi row", async () => {
    const photoId = await seedPhoto({ gps: true, idx: 1 });
    await setEmbeddingDone(photoId);
    // The #558 footprint: poi_detection already ran (done) but produced nothing.
    await db.insert(photoScanQueue).values({
      photo_id: photoId, user_id: null, service: "poi_detection", status: "done", priority: 2,
    });

    const queued = await enqueuePoiDetectionForMissingMatches(userId);

    expect(queued).toBe(1);
    expect(await pendingPoiRows(photoId)).toBe(1);
    // The stale done row is gone (replaced by the fresh pending one).
    const doneRows = await db.select({ id: photoScanQueue.id }).from(photoScanQueue).where(
      and(eq(photoScanQueue.photo_id, photoId), eq(photoScanQueue.service, "poi_detection"), eq(photoScanQueue.status, "done")),
    );
    expect(doneRows).toHaveLength(0);
  });

  it("skips photos without GPS, without a finished embedding, or that already have matches", async () => {
    // No GPS
    const noGps = await seedPhoto({ gps: false, idx: 2 });
    await setEmbeddingDone(noGps);

    // GPS but embedding not done
    const noEmbedding = await seedPhoto({ gps: true, idx: 3 });

    // GPS + embedding done but already has a POI match
    const hasMatch = await seedPhoto({ gps: true, idx: 4 });
    await setEmbeddingDone(hasMatch);
    await db.insert(photoPoiMatches).values({
      photo_id: hasMatch, osm_ref: "node/1", name: "Place", match_score: 0.9, source: "test",
    });

    const queued = await enqueuePoiDetectionForMissingMatches(userId);

    expect(queued).toBe(0);
    expect(await pendingPoiRows(noGps)).toBe(0);
    expect(await pendingPoiRows(noEmbedding)).toBe(0);
    expect(await pendingPoiRows(hasMatch)).toBe(0);
  });
});
