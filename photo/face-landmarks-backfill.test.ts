import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import { faces, photos, photoScanQueue, users } from "../db/schema";
import { createUserLogic } from "../user/user.service";
import { measureFaceEyes, type Point } from "./face-eyes";
import { backfillPhotoFaceLandmarks, enqueueFaceLandmarksBackfill } from "./photo.service";

/** Synthetic 68-point face in a 400×200 image: open eyes, raised corners. */
function face68(): Point[] {
  const pts: Point[] = Array.from({ length: 68 }, () => [100, 100] as Point);
  const eye = (base: number, x0: number) => {
    pts[base] = [x0, 80];
    pts[base + 1] = [x0 + 10, 75];
    pts[base + 2] = [x0 + 20, 75];
    pts[base + 3] = [x0 + 30, 80];
    pts[base + 4] = [x0 + 20, 85];
    pts[base + 5] = [x0 + 10, 85];
  };
  eye(36, 55);
  eye(42, 115);
  const mouth: Point[] = [[80, 134], [120, 134], [100, 132], [100, 148], [90, 146], [110, 146]];
  for (let i = 48; i <= 67; i++) pts[i] = mouth[i % mouth.length];
  return pts;
}

describe("facial-landmark backfill — queueing and re-measuring", () => {
  let photoId: number;
  const stored = measureFaceEyes({ landmark_3d_68: face68() }, 120, 400, 200);

  beforeEach(async () => {
    await db.delete(photoScanQueue);
    await db.delete(faces);
    await db.delete(photos);
    await db.delete(users);
    const u = await createUserLogic({
      email: `fl-${Date.now()}@example.com`,
      name: "FL",
      password: "pw",
    });
    const created = await dbInsertReturning<{ id: number }>(
      db.insert(photos)
        .values({
          user_id: u.id,
          // No file on disk: the re-measurement must not need one.
          filename: "/nonexistent/landmarks.jpg",
          original_name: "landmarks.jpg",
          mime_type: "image/jpeg",
          size: 1,
          width: 400,
          height: 200,
          external_path: "/nonexistent/landmarks.jpg",
        })
        .returning({ id: photos.id }),
    );
    photoId = created!.id;
  });

  afterAll(async () => {
    await db.delete(photoScanQueue);
    await db.delete(faces);
    await db.delete(photos);
    await db.delete(users);
  });

  it("fills the mouth shape from stored points without running the detector", async () => {
    await db.insert(faces).values({
      photo_id: photoId,
      bbox: JSON.stringify({ x: 0.1, y: 0.2, width: 0.3, height: 0.6 }),
      embedding: JSON.stringify([]),
      landmarks: JSON.stringify(stored.landmarks),
      eye_aspect_68: stored.eyeAspect68,
    });

    const queued = await enqueueFaceLandmarksBackfill();
    expect(queued).toEqual({ photos_enqueued: 1, faces_pending: 1 });
    const jobs = await db.select().from(photoScanQueue).where(eq(photoScanQueue.photo_id, photoId));
    expect(jobs.map((j) => [j.service, j.status, j.user_id])).toEqual([["face_landmarks", "pending", null]]);
    // Pressing the button again while the job waits queues nothing twice.
    expect((await enqueueFaceLandmarksBackfill()).photos_enqueued).toBe(0);

    // The file does not exist, so a detector run would throw.
    const result = await backfillPhotoFaceLandmarks(photoId);
    expect(result).toEqual({ faces_updated: 0, faces_remeasured: 1, faces_unmatched: 0 });

    const [row] = await db.select().from(faces).where(eq(faces.photo_id, photoId));
    expect(row!.mouth_lift_68).toBeCloseTo(stored.mouth68!.lift, 3);
    expect(row!.mouth_width_68).toBeCloseTo(stored.mouth68!.width, 3);
    expect(row!.eye_aspect_68).toBeCloseTo(stored.eyeAspect68!, 3);

    await db.delete(photoScanQueue);
    expect(await enqueueFaceLandmarksBackfill()).toEqual({ photos_enqueued: 0, faces_pending: 0 });
  });

  it("leaves faces below the size limit out, so they are not revisited forever", async () => {
    await db.insert(faces).values({
      photo_id: photoId,
      // 0.05 × 400 px = 20 px wide, under MIN_EYE_FACE_PIXELS.
      bbox: JSON.stringify({ x: 0.1, y: 0.2, width: 0.05, height: 0.1 }),
      embedding: JSON.stringify([]),
      landmarks: JSON.stringify(stored.landmarks),
    });

    expect(await enqueueFaceLandmarksBackfill()).toEqual({ photos_enqueued: 0, faces_pending: 0 });
  });

  it("queues faces without landmarks, and fails the job when the file is missing", async () => {
    await db.insert(faces).values({
      photo_id: photoId,
      bbox: JSON.stringify({ x: 0.1, y: 0.2, width: 0.3, height: 0.6 }),
      embedding: JSON.stringify([]),
    });

    expect(await enqueueFaceLandmarksBackfill()).toEqual({ photos_enqueued: 1, faces_pending: 1 });
    await expect(backfillPhotoFaceLandmarks(photoId)).rejects.toThrow();
  });
});
