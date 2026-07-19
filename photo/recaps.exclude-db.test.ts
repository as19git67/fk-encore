import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { photos, recaps, recapPhotos, recapExcludedPhotos, users } from "../db/schema";
import { excludeRecapPhoto, getRecapForUser } from "./recaps.service";

async function seedUser(email: string): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ email, name: "T", password_hash: "x" })
    .returning({ id: users.id });
  return u.id;
}

async function seedPhoto(userId: number, idx: number): Promise<number> {
  const [p] = await db
    .insert(photos)
    .values({
      user_id: userId,
      filename: `p${idx}.jpg`,
      original_name: `p${idx}.jpg`,
      mime_type: "image/jpeg",
      size: 1,
    })
    .returning({ id: photos.id });
  return p.id;
}

async function seedRecap(opts: {
  userId: number;
  chosen: number[];
  reserve: number[];
  cover: number | null;
}): Promise<number> {
  const [r] = await db
    .insert(recaps)
    .values({
      user_id: opts.userId,
      kind: "trip",
      title: "Test",
      subtitle: null,
      cover_photo_id: opts.cover,
      score: 1,
      dedup_key: `trip:test:${Math.random()}`,
      seed: { reserve_ids: opts.reserve },
    })
    .returning({ id: recaps.id });
  await db.insert(recapPhotos).values(
    opts.chosen.map((pid, idx) => ({ recap_id: r.id, photo_id: pid, rank: idx }))
  );
  return r.id;
}

beforeEach(async () => {
  await db.delete(recapExcludedPhotos);
  await db.delete(recapPhotos);
  await db.delete(recaps);
  await db.delete(photos);
  await db.delete(users);
});

describe("excludeRecapPhoto", () => {
  it("removes the photo, backfills from the reserve and persists the exclusion", async () => {
    const userId = await seedUser("a@test.dev");
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await seedPhoto(userId, i));
    const [c1, c2, c3, r1, r2] = ids;
    const recapId = await seedRecap({
      userId,
      chosen: [c1, c2, c3],
      reserve: [r1, r2],
      cover: c1,
    });

    const res = await excludeRecapPhoto(userId, recapId, c2);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.removed).toBe(c2);
    expect(res.added).toBe(r1);
    expect(res.photo_ids).toEqual([c1, c3, r1]);

    // Persisted: membership + exclusion row + shrunk reserve.
    const detail = await getRecapForUser(userId, recapId);
    expect(detail!.photo_ids).toEqual([c1, c3, r1]);
    expect(detail!.seed.reserve_ids).toEqual([r2]);

    const excl = await db
      .select({ photo_id: recapExcludedPhotos.photo_id })
      .from(recapExcludedPhotos)
      .where(eq(recapExcludedPhotos.recap_id, recapId));
    expect(excl.map((e) => e.photo_id)).toEqual([c2]);
  });

  it("moves the cover when the excluded photo was the cover", async () => {
    const userId = await seedUser("b@test.dev");
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await seedPhoto(userId, i));
    const [c1, c2, c3] = ids;
    const recapId = await seedRecap({ userId, chosen: [c1, c2, c3], reserve: [], cover: c1 });

    const res = await excludeRecapPhoto(userId, recapId, c1);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.photo_ids).toEqual([c2, c3]);
    expect(res.cover_photo_id).toBe(c2);
    const detail = await getRecapForUser(userId, recapId);
    expect(detail!.cover_photo_id).toBe(c2);
  });

  it("refuses to remove the last photo with no reserve", async () => {
    const userId = await seedUser("c@test.dev");
    const p = await seedPhoto(userId, 0);
    const recapId = await seedRecap({ userId, chosen: [p], reserve: [], cover: p });

    const res = await excludeRecapPhoto(userId, recapId, p);
    expect(res.status).toBe("would_empty");
    // Exclusion was rolled back and the photo is still there.
    const detail = await getRecapForUser(userId, recapId);
    expect(detail!.photo_ids).toEqual([p]);
  });

  it("returns not_found for a foreign or missing recap", async () => {
    const userId = await seedUser("d@test.dev");
    const other = await seedUser("e@test.dev");
    const p = await seedPhoto(other, 0);
    const recapId = await seedRecap({ userId: other, chosen: [p], reserve: [], cover: p });

    const res = await excludeRecapPhoto(userId, recapId, p);
    expect(res.status).toBe("not_found");
  });

  it("is idempotent for an already-excluded photo", async () => {
    const userId = await seedUser("f@test.dev");
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await seedPhoto(userId, i));
    const [c1, c2, c3, r1] = ids;
    const recapId = await seedRecap({ userId, chosen: [c1, c2, c3], reserve: [r1], cover: c1 });

    await excludeRecapPhoto(userId, recapId, c2);
    // Second call: c2 no longer present → no-op, no throw, no duplicate row.
    const res = await excludeRecapPhoto(userId, recapId, c2);
    expect(res.status).toBe("ok");
    const excl = await db
      .select({ photo_id: recapExcludedPhotos.photo_id })
      .from(recapExcludedPhotos)
      .where(eq(recapExcludedPhotos.recap_id, recapId));
    expect(excl.length).toBe(1);
  });
});
