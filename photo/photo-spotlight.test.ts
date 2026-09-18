// The feed the iOS Spotlight index follows (#768, further idea 2): which
// photos are in it, who may see them, and that the cursor walks the whole
// set without skipping or repeating.

import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { dbExec, dbInsertReturning } from "../db/adapter";
import {
  albumPhotos,
  albumShares,
  albums,
  faces,
  persons,
  photoOcr,
  photos,
  userFaceAssignments,
  users,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import {
  clampLimit,
  listChangedLogic,
  listIdsLogic,
  makeCursor,
  parseCursor,
  SPOTLIGHT_DEFAULT_LIMIT,
  SPOTLIGHT_MAX_LIMIT,
  SPOTLIGHT_TEXT_CAP,
} from "./photo-spotlight.service";

describe("cursor", () => {
  it("round-trips", () => {
    const c = makeCursor("2026-09-17T10:00:00.000Z", 42);
    expect(parseCursor(c)).toEqual({ changedAt: "2026-09-17T10:00:00.000Z", id: 42 });
  });

  it("reads anything malformed as 'from the beginning'", () => {
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor("")).toBeNull();
    expect(parseCursor("nonsense")).toBeNull();
    expect(parseCursor("2026-09-17T10:00:00.000Z|zero")).toBeNull();
    expect(parseCursor("not a date|3")).toBeNull();
  });

  it("clamps the page size", () => {
    expect(clampLimit(undefined)).toBe(SPOTLIGHT_DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(SPOTLIGHT_DEFAULT_LIMIT);
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(10_000)).toBe(SPOTLIGHT_MAX_LIMIT);
  });
});

describe("spotlight index feed", () => {
  let owner: { id: number };
  let member: { id: number };
  let stranger: { id: number };

  async function addPhoto(userId: number, opts: { text?: string; description?: string; taken_at?: string } = {}) {
    const row = await dbInsertReturning<{ id: number }>(
      db.insert(photos).values({
        user_id: userId,
        filename: `p-${Math.random().toString(36).slice(2)}.jpg`,
        original_name: "p.jpg",
        mime_type: "image/jpeg",
        size: 1,
        description: opts.description,
        taken_at: opts.taken_at,
      }).returning({ id: photos.id }),
    );
    if (opts.text !== undefined) {
      await dbExec(db.insert(photoOcr).values({ photo_id: row!.id, full_text: opts.text }));
    }
    return row!.id;
  }

  beforeEach(async () => {
    await db.delete(userFaceAssignments);
    await db.delete(faces);
    await db.delete(persons);
    await db.delete(albumShares);
    await db.delete(albumPhotos);
    await db.delete(albums);
    await db.delete(photoOcr);
    await db.delete(photos);
    await db.delete(users);
    owner = await createUserLogic({ email: "spot-owner@test.local", name: "O", password: "pw" });
    member = await createUserLogic({ email: "spot-member@test.local", name: "M", password: "pw" });
    stranger = await createUserLogic({ email: "spot-stranger@test.local", name: "S", password: "pw" });
  });

  it("lists only photos with recognised text or a description", async () => {
    const withText = await addPhoto(owner.id, { text: "Gleis 3" });
    const withDescription = await addPhoto(owner.id, { description: "Abfahrt" });
    await addPhoto(owner.id, { text: "" }); // scanned, nothing on it
    await addPhoto(owner.id); // never scanned

    const { items, next_cursor } = await listChangedLogic(owner.id, undefined, undefined);
    expect(items.map((i) => i.id).sort()).toEqual([withText, withDescription].sort());
    expect(next_cursor).toBeUndefined();
    const text = items.find((i) => i.id === withText)!;
    expect(text.text).toBe("Gleis 3");
    expect(text.description).toBeUndefined();
    const desc = items.find((i) => i.id === withDescription)!;
    expect(desc.text).toBe("");
    expect(desc.description).toBe("Abfahrt");

    expect((await listIdsLogic(owner.id)).ids.sort()).toEqual([withText, withDescription].sort());
  });

  it("answers only what the user may see", async () => {
    const own = await addPhoto(owner.id, { text: "eigenes" });
    const shared = await addPhoto(owner.id, { text: "geteilt" });
    await addPhoto(stranger.id, { text: "fremd" });

    const album = await dbInsertReturning<{ id: number }>(
      db.insert(albums).values({ user_id: owner.id, name: "Urlaub" }).returning({ id: albums.id }),
    );
    await dbExec(db.insert(albumPhotos).values({ album_id: album!.id, photo_id: shared }));
    await dbExec(db.insert(albumShares).values({ album_id: album!.id, user_id: member.id, access_level: "read" }));

    expect((await listIdsLogic(owner.id)).ids.sort()).toEqual([own, shared].sort());
    expect((await listIdsLogic(member.id)).ids).toEqual([shared]);
    const memberItems = (await listChangedLogic(member.id, undefined, undefined)).items;
    expect(memberItems.map((i) => i.id)).toEqual([shared]);
  });

  it("carries the names of the people the user has assigned", async () => {
    const photoId = await addPhoto(owner.id, { text: "Schild" });
    const face = await dbInsertReturning<{ id: number }>(
      db.insert(faces).values({ photo_id: photoId, bbox: "{}", embedding: "[]" }).returning({ id: faces.id }),
    );
    const person = await dbInsertReturning<{ id: number }>(
      db.insert(persons).values({ user_id: owner.id, name: "Testperson" }).returning({ id: persons.id }),
    );
    const unnamed = await dbInsertReturning<{ id: number }>(
      db.insert(persons).values({ user_id: owner.id }).returning({ id: persons.id }),
    );
    const face2 = await dbInsertReturning<{ id: number }>(
      db.insert(faces).values({ photo_id: photoId, bbox: "{}", embedding: "[]" }).returning({ id: faces.id }),
    );
    await dbExec(db.insert(userFaceAssignments).values([
      { user_id: owner.id, face_id: face!.id, person_id: person!.id },
      { user_id: owner.id, face_id: face2!.id, person_id: unnamed!.id },
    ]));

    const [item] = (await listChangedLogic(owner.id, undefined, undefined)).items;
    expect(item.person_names).toEqual(["Testperson"]);
  });

  it("caps the text it hands out", async () => {
    await addPhoto(owner.id, { text: "x".repeat(SPOTLIGHT_TEXT_CAP + 500) });
    const [item] = (await listChangedLogic(owner.id, undefined, undefined)).items;
    expect(item.text).toHaveLength(SPOTLIGHT_TEXT_CAP);
  });

  it("walks the whole set through the cursor without skipping or repeating", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(await addPhoto(owner.id, { text: `Text ${i}` }));
    // Pin the OCR side to one instant. `photos.updated_at` is trigger-
    // maintained (migration 0034) and cannot be pinned from a test, so the
    // rows differ by their insert time; the id tie-break is exercised by
    // the batch inserts sharing a transaction timestamp when they do.
    await db.execute(sql`UPDATE photo_ocr SET updated_at = '2026-01-01T00:00:00Z'`);

    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listChangedLogic(owner.id, cursor, 3);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(ids);
  });

  it("reports a photo again once its text or description changes", async () => {
    const photoId = await addPhoto(owner.id, { text: "alt" });
    const first = await listChangedLogic(owner.id, undefined, undefined);
    expect(first.items).toHaveLength(1);
    const cursor = first.items[0].cursor;

    expect((await listChangedLogic(owner.id, cursor, undefined)).items).toEqual([]);

    await dbExec(
      db.update(photoOcr).set({ full_text: "neu", updated_at: sql`NOW()` }).where(eq(photoOcr.photo_id, photoId)),
    );
    const again = await listChangedLogic(owner.id, cursor, undefined);
    expect(again.items.map((i) => i.id)).toEqual([photoId]);
    expect(again.items[0].text).toBe("neu");
  });
});
