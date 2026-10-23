import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import { faces, photos, users } from "../db/schema";
import { createUserLogic } from "../user/user.service";
import { measureFaceEyes, type Point } from "./face-eyes";
import { backfillFaceLandmarksLogic } from "./photo.service";

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

describe("backfillFaceLandmarksLogic — re-measuring stored landmarks", () => {
  let photoId: number;
  const stored = measureFaceEyes({ landmark_3d_68: face68() }, 120, 400, 200);

  beforeEach(async () => {
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

    const result = await backfillFaceLandmarksLogic();
    expect(result.faces_remeasured).toBe(1);
    expect(result.faces_updated).toBe(0);
    // The file does not exist, so a detector run would have failed the photo.
    expect(result.photos_failed).toBe(0);

    const [row] = await db.select().from(faces).where(eq(faces.photo_id, photoId));
    expect(row!.mouth_lift_68).toBeCloseTo(stored.mouth68!.lift, 3);
    expect(row!.mouth_width_68).toBeCloseTo(stored.mouth68!.width, 3);
    expect(row!.eye_aspect_68).toBeCloseTo(stored.eyeAspect68!, 3);

    const second = await backfillFaceLandmarksLogic();
    expect(second.photos_scanned).toBe(0);
  });

  it("leaves faces below the size limit out, so they are not revisited forever", async () => {
    await db.insert(faces).values({
      photo_id: photoId,
      // 0.05 × 400 px = 20 px wide, under MIN_EYE_FACE_PIXELS.
      bbox: JSON.stringify({ x: 0.1, y: 0.2, width: 0.05, height: 0.1 }),
      embedding: JSON.stringify([]),
      landmarks: JSON.stringify(stored.landmarks),
    });

    const result = await backfillFaceLandmarksLogic();
    expect(result.photos_scanned).toBe(0);
  });
});
