// The user's hidden photos stay out of the natural-language search and the
// assistant's person counts unless the caller asks for them. The search's
// CLIP hits used to come back unfiltered: a hidden photo the image model
// found showed up in the result.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import { faces, persons, photoCuration, photos, userFaceAssignments, users } from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";

describe("hidden photos", () => {
  let user: any;
  let shown: { id: number };
  let hidden: { id: number };

  async function addPhoto(name: string, takenAt: string): Promise<{ id: number }> {
    const row = await dbInsertReturning<{ id: number }>(
      db.insert(photos).values({
        user_id: user.id, filename: name, original_name: name, mime_type: "image/jpeg", size: 1, taken_at: takenAt,
      }).returning()
    );
    return row!;
  }

  beforeEach(async () => {
    await db.delete(userFaceAssignments);
    await db.delete(faces);
    await db.delete(persons);
    await db.delete(photoCuration);
    await db.delete(photos);
    await db.delete(users);
    user = await createUserLogic({ email: "hidden@test.local", name: "H", password: "pw" });
    shown = await addPhoto("shown.jpg", "2024-05-01T10:00:00.000Z");
    hidden = await addPhoto("hidden.jpg", "2024-05-02T10:00:00.000Z");
    await db.insert(photoCuration).values({ user_id: user.id, photo_id: hidden.id, status: "hidden" });
  });

  afterEach(() => vi.unstubAllGlobals());

  describe("natural-language search", () => {
    beforeEach(() => {
      // The embedding service: the parser keeps the whole query semantic,
      // the image search finds both photos.
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        const body = String(url).endsWith("/parse/query")
          ? { semantic_query: "strand", location: null, from_date: null, to_date: null }
          : { results: [{ photo_id: String(shown.id), score: 0.4 }, { photo_id: String(hidden.id), score: 0.5 }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }));
    });

    it("leaves hidden photos out of the image hits by default", async () => {
      const res = await service.searchPhotosNaturalLogic(user.id, "Strand");
      expect(res.results.map((r) => r.photoId)).toEqual([shown.id]);
    });

    it("includes them, or returns only them, on request", async () => {
      const all = await service.searchPhotosNaturalLogic(user.id, "Strand", 30, 0.18, "include");
      expect(all.results.map((r) => r.photoId).sort()).toEqual([shown.id, hidden.id].sort());
      const only = await service.searchPhotosNaturalLogic(user.id, "Strand", 30, 0.18, "only");
      expect(only.results.map((r) => r.photoId)).toEqual([hidden.id]);
    });
  });

  it("counts faces on hidden photos only when asked to", async () => {
    const person = await dbInsertReturning<{ id: number }>(
      db.insert(persons).values({ user_id: user.id, name: "Beispielperson" }).returning()
    );
    for (const p of [shown, hidden]) {
      const face = await dbInsertReturning<{ id: number }>(
        db.insert(faces).values({ photo_id: p.id, bbox: JSON.stringify({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }), embedding: JSON.stringify([0.1]) }).returning()
      );
      await db.insert(userFaceAssignments).values({ user_id: user.id, face_id: face!.id, person_id: person!.id, ignored: false });
    }

    const page = (await service.listPersonsLogic(user.id)).persons.find((p) => p.id === person!.id)!;
    expect(page.faceCount).toBe(2);
    expect(page.newest_photo_at?.slice(0, 10)).toBe("2024-05-02");

    const assistant = (await service.listPersonsLogic(user.id, undefined, { hidden: "exclude" })).persons.find((p) => p.id === person!.id)!;
    expect(assistant.faceCount).toBe(1);
    expect(assistant.newest_photo_at?.slice(0, 10)).toBe("2024-05-01");
  });
});
