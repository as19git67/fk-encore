/**
 * "Das Foto mit den meisten Likes", "mit den wenigsten Kommentaren", "auf dem
 * Max am besten zu sehen ist": the photo list ranks by metrics it computes
 * — favourites of every user, comments in any album, the face of a person —
 * and hands the value back as `rank_value`. Every user, face and photo here
 * is synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import { albums, faces, persons, photoComments, photoCuration, photos, userFaceAssignments, users } from "../db/schema";
import { listPhotosLogic, parsePhotoSortField } from "./photo.service";

describe("parsePhotoSortField", () => {
  it("knows the metrics and falls back to the date", () => {
    expect(parsePhotoSortField("favorites")).toBe("favorites");
    expect(parsePhotoSortField("face")).toBe("face");
    expect(parsePhotoSortField("best")).toBe("date");
    expect(parsePhotoSortField(undefined)).toBe("date");
  });
});

describe("listPhotosLogic ranking", () => {
  let owner: number;
  let viewer: number;
  let person: number;
  const ids: Record<string, number> = {};

  async function makeUser(email: string): Promise<number> {
    const row = await dbInsertReturning<{ id: number }>(
      db.insert(users).values({ email, name: "Test", password_hash: "x" }).returning({ id: users.id }),
    );
    return row!.id;
  }

  async function makePhoto(key: string, values: Partial<typeof photos.$inferInsert>) {
    const row = await dbInsertReturning<{ id: number }>(
      db.insert(photos).values({
        user_id: owner, filename: `rank-${key}-${Math.random().toString(36).slice(2)}.jpg`, original_name: "p.jpg",
        mime_type: "image/jpeg", size: 1000, ...values,
      }).returning({ id: photos.id }),
    );
    ids[key] = row!.id;
  }

  async function makeFace(photoId: number, width: number, height: number, sharpness: number | null, personId: number | null = person) {
    const face = await dbInsertReturning<{ id: number }>(
      db.insert(faces).values({ photo_id: photoId, bbox: JSON.stringify({ x: 0.1, y: 0.1, width, height }), embedding: "[]", sharpness }).returning({ id: faces.id }),
    );
    await db.insert(userFaceAssignments).values({ user_id: owner, face_id: face!.id, person_id: personId });
  }

  beforeAll(async () => {
    owner = await makeUser("rank-owner@test.local");
    viewer = await makeUser("rank-viewer@test.local");
    const p = await dbInsertReturning<{ id: number }>(
      db.insert(persons).values({ user_id: owner, name: "Max" }).returning({ id: persons.id }),
    );
    person = p!.id;
    await makePhoto("a", { taken_at: "2024-01-01T10:00:00Z", size: 10 });
    await makePhoto("b", { taken_at: "2024-02-01T10:00:00Z", size: 30 });
    await makePhoto("c", { taken_at: "2024-03-01T10:00:00Z", size: 20 });

    // Favourites: b by both users, a by the viewer only, c by nobody.
    await db.insert(photoCuration).values([
      { user_id: owner, photo_id: ids.b!, status: "favorite" },
      { user_id: viewer, photo_id: ids.b!, status: "favorite" },
      { user_id: viewer, photo_id: ids.a!, status: "favorite" },
      { user_id: owner, photo_id: ids.c!, status: "visible" },
    ]);

    // Comments: two under a, one under c, in a shared album.
    const album = await dbInsertReturning<{ id: number }>(
      db.insert(albums).values({ user_id: owner, name: "Rank" }).returning({ id: albums.id }),
    );
    await db.insert(photoComments).values([
      { photo_id: ids.a!, album_id: album!.id, user_id: viewer, body: "schön" },
      { photo_id: ids.a!, album_id: album!.id, user_id: owner, body: "danke" },
      { photo_id: ids.c!, album_id: album!.id, user_id: viewer, body: "oh" },
    ]);

    // Faces of Max: large and sharp on c, large but blurred on a, small on b;
    // a face of someone else on b is big and sharp but does not count.
    await makeFace(ids.c!, 0.4, 0.5, 0.9);
    await makeFace(ids.a!, 0.4, 0.5, 0.1);
    await makeFace(ids.b!, 0.05, 0.05, 1);
    await makeFace(ids.b!, 0.6, 0.6, 1, null);
  });

  afterAll(async () => {
    const photoIds = Object.values(ids);
    await db.delete(photoComments).where(inArray(photoComments.photo_id, photoIds));
    await db.delete(albums).where(eq(albums.user_id, owner));
    await db.delete(photos).where(eq(photos.user_id, owner));
    await db.delete(persons).where(eq(persons.id, person));
    await db.delete(users).where(inArray(users.id, [owner, viewer]));
  });

  const order = async (opts: Parameters<typeof listPhotosLogic>[2]) =>
    (await listPhotosLogic(owner, {}, opts)).photos.map((p) => [p.id, p.rank_value] as const);

  it("counts the favourites of every user, highest first, and says the count", async () => {
    expect(await order({ sortBy: "favorites" })).toEqual([[ids.b, 2], [ids.a, 1], [ids.c, 0]]);
  });

  it("counts the comments, and 'the fewest' puts the uncommented first", async () => {
    expect(await order({ sortBy: "comments", order: "asc" })).toEqual([[ids.b, 0], [ids.c, 1], [ids.a, 2]]);
  });

  it("rates the face of the asked person by size and sharpness, other persons' faces not at all", async () => {
    const rows = await order({ sortBy: "face", facePersonIds: [person] });
    expect(rows.map(([id]) => id)).toEqual([ids.c, ids.a, ids.b]);
    expect(rows[0]![1]).toBeCloseTo(0.9 * 0.2 * 100, 3);
    // Without a person there is nothing to rate: the date order, no value.
    const none = await order({ sortBy: "face" });
    expect(none.map(([id]) => id)).toEqual([ids.c, ids.b, ids.a]);
    expect(none.every(([, v]) => v === undefined)).toBe(true);
  });

  it("ranks by file size and carries no value for the date order", async () => {
    expect((await order({ sortBy: "size" })).map(([id]) => id)).toEqual([ids.b, ids.c, ids.a]);
    expect((await order({})).every(([, v]) => v === undefined)).toBe(true);
  });
});
