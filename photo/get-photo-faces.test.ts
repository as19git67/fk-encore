import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import { users, photos, faces, persons, userFaceAssignments } from "../db/schema";
import { dbInsertReturning } from "../db/adapter";
import { createUserLogic } from "../user/user.service";
import { getPhotoFacesLogic } from "./photo.service";

/**
 * Ground-truth for the photo-detail sidebar "Personen" section: a face that
 * the viewing user has assigned to a named person must come back from
 * getPhotoFacesLogic with that person_id — regardless of who uploaded the
 * photo. (The sidebar was reported empty everywhere; this pins the backend.)
 */
describe("getPhotoFacesLogic", () => {
  let owner: any;

  beforeEach(async () => {
    await db.delete(userFaceAssignments);
    await db.delete(faces);
    await db.delete(persons);
    await db.delete(photos);
    await db.delete(users);
    owner = await createUserLogic({ email: "faces@test.com", name: "Owner", password: "pw" });
  });

  async function makePhoto(userId: number): Promise<number> {
    const row = await dbInsertReturning<{ id: number }>(
      db.insert(photos).values({
        user_id: userId, filename: "f.jpg", original_name: "f.jpg",
        mime_type: "image/jpeg", size: 1,
      }).returning({ id: photos.id }),
    );
    return row!.id;
  }

  async function makeFace(photoId: number): Promise<number> {
    const row = await dbInsertReturning<{ id: number }>(
      db.insert(faces).values({
        photo_id: photoId,
        bbox: JSON.stringify({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }),
        embedding: "[]",
      }).returning({ id: faces.id }),
    );
    return row!.id;
  }

  it("returns the viewer's assigned person for a detected face", async () => {
    const photoId = await makePhoto(owner.id);
    const faceId = await makeFace(photoId);
    const person = await dbInsertReturning<{ id: number }>(
      db.insert(persons).values({ user_id: owner.id, name: "Alice" }).returning({ id: persons.id }),
    );
    await db.insert(userFaceAssignments).values({
      user_id: owner.id, face_id: faceId, person_id: person!.id, ignored: false,
    });

    const { faces: out } = await getPhotoFacesLogic(owner.id, photoId);
    expect(out).toHaveLength(1);
    expect(out[0]!.person_id).toBe(person!.id);
    // The person name is resolved server-side so the sidebar doesn't depend
    // on a separately-loaded persons list.
    expect(out[0]!.person_name).toBe("Alice");
    expect(out[0]!.ignored).toBe(false);
  });

  it("returns nothing for a user who has no assignment row for the face", async () => {
    // Documents the current behaviour: the inner join to user_face_assignments
    // means a viewer with no assignment (e.g. a freshly shared album member)
    // sees no faces at all.
    const photoId = await makePhoto(owner.id);
    await makeFace(photoId);
    const viewer = await createUserLogic({ email: "viewer@test.com", name: "Viewer", password: "pw" });

    const { faces: out } = await getPhotoFacesLogic(viewer.id, photoId);
    expect(out).toHaveLength(0);
  });
});
