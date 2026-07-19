import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { photos, recaps, recapPhotos, recapExcludedPhotos, users } from "../db/schema";
import {
  excludeRecapPhoto,
  rebuildRecapsForUser,
  getRecapForUser,
} from "./recaps.service";

async function seedUser(email: string): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ email, name: "T", password_hash: "x" })
    .returning({ id: users.id });
  return u.id;
}

async function seedPlacePhotos(userId: number, count: number): Promise<void> {
  const rows = [];
  for (let i = 0; i < count; i++) {
    // Spread across many distinct days, well outside the burst-dedup window,
    // so every photo survives dedupBursts as its own candidate.
    const day = i + 1;
    rows.push({
      user_id: userId,
      filename: `place-${i}.jpg`,
      original_name: `place-${i}.jpg`,
      mime_type: "image/jpeg",
      size: 1,
      taken_at: `2025-01-${String((day % 28) + 1).padStart(2, "0")}T${String(
        8 + (i % 10)
      ).padStart(2, "0")}:00:00Z`,
      location_city: "Testort",
      ai_quality_score: Math.random(),
    });
  }
  await db.insert(photos).values(rows);
}

beforeEach(async () => {
  await db.delete(recapExcludedPhotos);
  await db.delete(recapPhotos);
  await db.delete(recaps);
  await db.delete(photos);
  await db.delete(users);
});

describe("end-to-end: build a real recap, then exclude a photo", () => {
  it("backfills from the reserve computed by the actual builder pipeline", async () => {
    const userId = await seedUser("e2e@test.dev");
    // 45 photos > MAX_PHOTOS_PER_RECAP (30) and > PLACE_MIN_PHOTOS (20),
    // spread across 28 distinct days > PLACE_MIN_DISTINCT_DAYS (3), so a
    // place recap is built with a genuine reserve beyond the chosen 30.
    await seedPlacePhotos(userId, 45);

    await rebuildRecapsForUser(userId);

    const recap = await db
      .select({ id: recaps.id, seed: recaps.seed })
      .from(recaps)
      .where(eq(recaps.user_id, userId))
      .limit(1);
    expect(recap.length).toBe(1);
    const recapId = recap[0]!.id;
    const seed = recap[0]!.seed as Record<string, unknown>;

    // This is the crux of the bug report: reserve_ids must actually be
    // populated by the real builder pipeline, not just by a hand-seeded test.
    const reserveIds = seed.reserve_ids;
    expect(Array.isArray(reserveIds)).toBe(true);
    expect((reserveIds as number[]).length).toBeGreaterThan(0);

    const before = await getRecapForUser(userId, recapId);
    expect(before!.photo_ids.length).toBe(30);

    const victim = before!.photo_ids[0]!;
    const res = await excludeRecapPhoto(userId, recapId, victim);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;

    // The whole point of the feature: count stays the same, next-best added.
    expect(res.photo_ids.length).toBe(30);
    expect(res.added).not.toBeNull();
    expect(res.photo_ids).not.toContain(victim);

    const after = await getRecapForUser(userId, recapId);
    expect(after!.photo_ids.length).toBe(30);
  });

  it("self-heals a recap built before the reserve feature existed (no seed.reserve_ids)", async () => {
    const userId = await seedUser("stale@test.dev");
    // 45 real candidate photos exist, but the recap row below simulates one
    // written by the pre-#885 code: only 30 photo_ids, seed has no
    // reserve_ids key at all — exactly what every recap in production looked
    // like right after this feature shipped.
    await seedPlacePhotos(userId, 45);
    const allIds = (
      await db.select({ id: photos.id }).from(photos).where(eq(photos.user_id, userId))
    ).map((p) => p.id);
    const chosen = allIds.slice(0, 30);

    const [staleRecap] = await db
      .insert(recaps)
      .values({
        user_id: userId,
        kind: "place",
        title: "Testort",
        subtitle: null,
        cover_photo_id: chosen[0]!,
        score: 1,
        dedup_key: "place:testort",
        seed: { location_city: "Testort", photo_count: 30, distinct_days: 20 },
      })
      .returning({ id: recaps.id });
    await db.insert(recapPhotos).values(
      chosen.map((pid, idx) => ({ recap_id: staleRecap.id, photo_id: pid, rank: idx }))
    );

    const victim = chosen[0]!;
    const res = await excludeRecapPhoto(userId, staleRecap.id, victim);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;

    // The bug: without self-heal this silently shrinks to 29. With it, the
    // rebuild recomputes a real reserve and backfills.
    expect(res.photo_ids).not.toContain(victim);
    expect(res.photo_ids.length).toBe(30);
    expect(res.added).not.toBeNull();
  });
});
