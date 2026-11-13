/**
 * "Fotos ohne Lena", "Lena und Max zusammen", "mit Lena, aber ohne Max": who
 * is on a photo, beyond "one of these persons". Every user, person and photo
 * here is synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import { faces, persons, photos, userFaceAssignments, users } from "../db/schema";
import { listPhotosLogic } from "./photo.service";
import { parsePhotoFilterQuery } from "./photo.filters";

describe("parsePhotoFilterQuery persons", () => {
  it("reads the excluded persons and the match next to the included ones", () => {
    expect(parsePhotoFilterQuery({ personIds: "1,2", personMatch: "all", withoutPersonIds: "3, 4" })).toMatchObject({
      personIds: [1, 2], personMatch: "all", withoutPersonIds: [3, 4],
    });
    expect(parsePhotoFilterQuery({ personMatch: "some" })).not.toHaveProperty("personMatch");
  });
});

describe("listPhotosLogic persons", () => {
  let owner: number;
  let a: number;
  let b: number;
  const ids: Record<string, number> = {};

  async function makePhoto(key: string, onIt: number[], ignored: number[] = []) {
    const row = await dbInsertReturning<{ id: number }>(
      db.insert(photos).values({
        user_id: owner, filename: `persons-${key}-${Math.random().toString(36).slice(2)}.jpg`, original_name: "p.jpg",
        mime_type: "image/jpeg", size: 1000, taken_at: `2024-01-0${Object.keys(ids).length + 1}T10:00:00Z`,
      }).returning({ id: photos.id }),
    );
    ids[key] = row!.id;
    for (const personId of [...onIt, ...ignored]) {
      const face = await dbInsertReturning<{ id: number }>(
        db.insert(faces).values({ photo_id: row!.id, bbox: JSON.stringify({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }), embedding: "[]" }).returning({ id: faces.id }),
      );
      await db.insert(userFaceAssignments).values({ user_id: owner, face_id: face!.id, person_id: personId, ignored: ignored.includes(personId) });
    }
  }

  beforeAll(async () => {
    const u = await dbInsertReturning<{ id: number }>(
      db.insert(users).values({ email: "persons-owner@test.local", name: "Test", password_hash: "x" }).returning({ id: users.id }),
    );
    owner = u!.id;
    const pa = await dbInsertReturning<{ id: number }>(db.insert(persons).values({ user_id: owner, name: "Person A" }).returning({ id: persons.id }));
    const pb = await dbInsertReturning<{ id: number }>(db.insert(persons).values({ user_id: owner, name: "Person B" }).returning({ id: persons.id }));
    a = pa!.id;
    b = pb!.id;
    await makePhoto("none", []);
    await makePhoto("a", [a]);
    await makePhoto("b", [b]);
    await makePhoto("ab", [a, b]);
    // B's face is ignored here: the photo counts as one without B.
    await makePhoto("aIgnoredB", [a], [b]);
  });

  afterAll(async () => {
    const photoIds = Object.values(ids);
    await db.delete(userFaceAssignments).where(eq(userFaceAssignments.user_id, owner));
    await db.delete(faces).where(inArray(faces.photo_id, photoIds));
    await db.delete(photos).where(eq(photos.user_id, owner));
    await db.delete(persons).where(inArray(persons.id, [a, b]));
    await db.delete(users).where(eq(users.id, owner));
  });

  const keys = async (filter: Parameters<typeof listPhotosLogic>[1]) => {
    const found = new Set((await listPhotosLogic(owner, filter)).photos.map((p) => p.id));
    return Object.entries(ids).filter(([, id]) => found.has(id)).map(([k]) => k).sort();
  };

  it("leaves out every photo a person is on", async () => {
    expect(await keys({ withoutPersonIds: [b] })).toEqual(["a", "aIgnoredB", "none"]);
    expect(await keys({ withoutPersonIds: [a, b] })).toEqual(["none"]);
  });

  it("takes one person and leaves out another in the same filter", async () => {
    expect(await keys({ personIds: [a], withoutPersonIds: [b] })).toEqual(["a", "aIgnoredB"]);
  });

  it("finds photos with any of the persons, or only those with all of them", async () => {
    expect(await keys({ personIds: [a, b] })).toEqual(["a", "aIgnoredB", "ab", "b"]);
    expect(await keys({ personIds: [a, b], personMatch: "all" })).toEqual(["ab"]);
  });
});
