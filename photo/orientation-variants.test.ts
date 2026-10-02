import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbExec, dbInsertReturning } from "../db/adapter";
import {
  photoCuration,
  photoGroupMembers,
  photoGroups,
  photos,
  users,
} from "../db/schema";
import {
  VARIANT_TIME_WINDOW_SECONDS,
  bestPerOrientation,
  computeOrientationVariants,
  counterpartsByPhotoId,
  getCollapseOrientationVariantsLogic,
  photoOrientation,
  setCollapseOrientationVariantsLogic,
  setGroupOrientationVariantsLogic,
} from "./orientation-variants";
import { listGalleryGridLogic, listGalleryIdsLogic } from "./gallery-grid.service";
import { listPhotoGroupsLogic, listPhotosLogic } from "./photo.service";
import { keepBestPerOrientationLogic, listReviewQueueLogic } from "./group-auto-pick.service";

// ── Pure rule ──────────────────────────────────────────────────────────────

const T0 = Date.parse("2024-06-01T10:00:00.000Z");
const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

function member(
  id: number,
  o: "portrait" | "landscape" | "square" | "unknown",
  offsetSeconds: number | null,
  hidden = false,
) {
  const dims =
    o === "portrait" ? { width: 3000, height: 4000 }
    : o === "landscape" ? { width: 4000, height: 3000 }
    : o === "square" ? { width: 3000, height: 3000 }
    : { width: null, height: null };
  return {
    photo_id: id,
    ...dims,
    taken_at: offsetSeconds === null ? null : iso(offsetSeconds),
    hidden,
  };
}

describe("photoOrientation", () => {
  it("classifies by aspect ratio and says null when the dimensions are unknown", () => {
    expect(photoOrientation(4000, 3000)).toBe("landscape");
    expect(photoOrientation(3000, 4000)).toBe("portrait");
    expect(photoOrientation(3000, 3000)).toBe("square");
    expect(photoOrientation(null, 3000)).toBeNull();
    expect(photoOrientation(0, 0)).toBeNull();
  });
});

describe("computeOrientationVariants", () => {
  it("forms a format group from one portrait and one landscape frame within the window", () => {
    const r = computeOrientationVariants(
      [member(1, "portrait", 0), member(2, "landscape", 30)],
      null,
    );
    expect(r).toEqual({ portrait: 1, landscape: 1, portrait_ids: [1], landscape_ids: [2] });
  });

  it("uses the tight variant window, not the ten-minute grouping window", () => {
    const inside = computeOrientationVariants(
      [member(1, "portrait", 0), member(2, "landscape", VARIANT_TIME_WINDOW_SECONDS)],
      null,
    );
    expect(inside).not.toBeNull();
    const outside = computeOrientationVariants(
      [member(1, "portrait", 0), member(2, "landscape", VARIANT_TIME_WINDOW_SECONDS + 1)],
      null,
    );
    expect(outside).toBeNull();
  });

  it("shows a whole side rather than pairing: 3 portrait + 2 landscape all belong", () => {
    const r = computeOrientationVariants(
      [
        member(1, "portrait", 0),
        member(2, "portrait", 10),
        member(3, "portrait", 20),
        member(4, "landscape", 5),
        member(5, "landscape", 15),
      ],
      "auto",
    );
    expect(r).toMatchObject({ portrait: 3, landscape: 2, portrait_ids: [1, 2, 3], landscape_ids: [4, 5] });
  });

  it("leaves out a frame that is too far from every frame of the other side", () => {
    const r = computeOrientationVariants(
      [
        member(1, "portrait", 0),
        member(2, "landscape", 10),
        member(3, "landscape", 500),
      ],
      null,
    );
    expect(r).toMatchObject({ portrait: 1, landscape: 1, landscape_ids: [2] });
  });

  it("never counts squares, unknown dimensions, hidden members or members without a date", () => {
    expect(computeOrientationVariants([member(1, "portrait", 0), member(2, "square", 1)], null)).toBeNull();
    expect(computeOrientationVariants([member(1, "portrait", 0), member(2, "unknown", 1)], null)).toBeNull();
    expect(computeOrientationVariants([member(1, "portrait", 0), member(2, "landscape", 1, true)], null)).toBeNull();
    expect(computeOrientationVariants([member(1, "portrait", null), member(2, "landscape", 1)], null)).toBeNull();
  });

  it("is switched off per group", () => {
    expect(computeOrientationVariants([member(1, "portrait", 0), member(2, "landscape", 1)], "off")).toBeNull();
  });
});

describe("bestPerOrientation", () => {
  const m = (id: number, o: "portrait" | "landscape" | "square" | "unknown", score: number | null, hidden = false) => ({
    photo_id: id,
    ...(o === "portrait" ? { width: 3000, height: 4000 }
      : o === "landscape" ? { width: 4000, height: 3000 }
      : o === "square" ? { width: 3000, height: 3000 }
      : { width: null, height: null }),
    ai_quality_score: score,
    hidden,
  });

  it("keeps the best-rated frame of every orientation present", () => {
    expect(bestPerOrientation([
      m(1, "portrait", 0.5), m(2, "portrait", 0.8), m(3, "landscape", 0.3), m(4, "landscape", 0.9),
    ]).sort()).toEqual([2, 4]);
  });

  it("keeps one frame per orientation as it is, and never drops what it cannot see", () => {
    expect(bestPerOrientation([m(1, "portrait", 0.2), m(2, "landscape", 0.1)]).sort()).toEqual([1, 2]);
    expect(bestPerOrientation([m(1, "portrait", 0.9), m(2, "square", null), m(3, "unknown", null)]).sort()).toEqual([1, 2, 3]);
  });

  it("falls back to member order among unscored frames and skips hidden ones", () => {
    expect(bestPerOrientation([m(1, "portrait", null), m(2, "portrait", null)])).toEqual([1]);
    expect(bestPerOrientation([m(1, "portrait", 0.9, true), m(2, "portrait", 0.1)])).toEqual([2]);
  });
});

// ── Database behaviour ─────────────────────────────────────────────────────

async function makeUser(email: string): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(users).values({ email, name: "Test", password_hash: "x" }).returning({ id: users.id }),
  );
  return row!.id;
}

async function makePhoto(
  userId: number,
  o: "portrait" | "landscape" | "unknown",
  offsetSeconds: number | null,
): Promise<number> {
  const dims =
    o === "portrait" ? { width: 3000, height: 4000 }
    : o === "landscape" ? { width: 4000, height: 3000 }
    : { width: null, height: null };
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(photos).values({
      user_id: userId,
      filename: `p-${Math.random().toString(36).slice(2)}.jpg`,
      original_name: "p.jpg",
      mime_type: "image/jpeg",
      size: 1000,
      taken_at: offsetSeconds === null ? null : iso(offsetSeconds),
      ...dims,
    }).returning({ id: photos.id }),
  );
  return row!.id;
}

async function makeGroup(userId: number, coverPhotoId: number, memberIds: number[]): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(photoGroups).values({ user_id: userId, cover_photo_id: coverPhotoId }).returning({ id: photoGroups.id }),
  );
  const groupId = row!.id;
  for (let i = 0; i < memberIds.length; i++) {
    await dbExec(
      db.insert(photoGroupMembers).values({ group_id: groupId, photo_id: memberIds[i], similarity_rank: i }),
    );
  }
  return groupId;
}

const grid = { limit: 100, offset: 0, sortBy: "taken_at", sortDir: "asc" } as const;

async function gridIds(userId: number, variantMode: "all" | "portrait" | "landscape") {
  const res = await listGalleryGridLogic(userId, { variantMode }, grid);
  return res.photos.map((p) => p.id).sort((a, b) => a - b);
}

describe("orientation variants in the gallery grid", () => {
  let u: number;

  beforeEach(async () => {
    await db.delete(photoGroupMembers);
    await db.delete(photoGroups);
    await db.delete(photoCuration);
    await db.delete(photos);
    await db.delete(users);
    u = await makeUser("variants@test.com");
  });

  it("shows only the matching side of a format group and keeps the total honest", async () => {
    const portrait = await makePhoto(u, "portrait", 0);
    const landscape = await makePhoto(u, "landscape", 20);
    const loner = await makePhoto(u, "landscape", 5000);
    await makeGroup(u, portrait, [portrait, landscape]);

    const all = await listGalleryGridLogic(u, { variantMode: "all" }, grid);
    expect(all.total).toBe(3);

    const portraitView = await listGalleryGridLogic(u, { variantMode: "portrait" }, grid);
    expect(portraitView.photos.map((p) => p.id).sort((a, b) => a - b)).toEqual([portrait, loner].sort((a, b) => a - b));
    // The total follows the filter: the grid is server-paginated and a
    // total that disagrees with the rows would tear holes into offsets.
    expect(portraitView.total).toBe(2);

    expect(await gridIds(u, "landscape")).toEqual([landscape, loner].sort((a, b) => a - b));

    // Default (no variantMode) is "all": nothing changes for callers that
    // do not know about format groups.
    const legacy = await listGalleryGridLogic(u, {}, grid);
    expect(legacy.total).toBe(3);

    // Select-all follows the same filter.
    const ids = await listGalleryIdsLogic(u, { variantMode: "portrait" }, { sortBy: "taken_at", sortDir: "asc" });
    expect(ids.ids.sort((a, b) => a - b)).toEqual([portrait, loner].sort((a, b) => a - b));
  });

  it("reports orientation and the per-side counts on the shown tile", async () => {
    const p1 = await makePhoto(u, "portrait", 0);
    const p2 = await makePhoto(u, "portrait", 10);
    const l1 = await makePhoto(u, "landscape", 5);
    const unknown = await makePhoto(u, "unknown", 7);
    await makeGroup(u, p1, [p1, p2, l1, unknown]);

    const res = await listGalleryGridLogic(u, { variantMode: "landscape" }, grid);
    const byId = new Map(res.photos.map((p) => [p.id, p]));
    expect(byId.get(l1)!.orientation).toBe("landscape");
    expect(byId.get(l1)!.group?.variants).toEqual({
      portrait: 2, landscape: 1, portrait_ids: [p1, p2], landscape_ids: [l1],
    });
    // The unknown frame is neither side: it stays visible in both modes
    // and reports its orientation as unknown.
    expect(byId.get(unknown)!.orientation).toBeNull();
    expect(byId.has(p1)).toBe(false);
    expect(byId.has(p2)).toBe(false);

    const all = await listGalleryGridLogic(u, { variantMode: "all" }, grid);
    for (const p of all.photos) expect(p.group?.variants).toMatchObject({ portrait: 2, landscape: 1 });
  });

  it("does not form a format group outside the variant time window", async () => {
    const portrait = await makePhoto(u, "portrait", 0);
    const landscape = await makePhoto(u, "landscape", VARIANT_TIME_WINDOW_SECONDS + 1);
    await makeGroup(u, portrait, [portrait, landscape]);

    expect(await gridIds(u, "portrait")).toEqual([portrait, landscape].sort((a, b) => a - b));
    const res = await listGalleryGridLogic(u, { variantMode: "all" }, grid);
    for (const p of res.photos) expect(p.group?.variants).toBeUndefined();
  });

  it("only counts members that are visible for this user", async () => {
    const portrait = await makePhoto(u, "portrait", 0);
    const landscape = await makePhoto(u, "landscape", 10);
    const landscape2 = await makePhoto(u, "landscape", 20);
    await makeGroup(u, portrait, [portrait, landscape, landscape2]);
    await db.insert(photoCuration).values({ user_id: u, photo_id: portrait, status: "hidden" });

    // The only portrait is hidden, so there is no format group: both
    // landscapes stay in the portrait view.
    expect(await gridIds(u, "portrait")).toEqual([landscape, landscape2].sort((a, b) => a - b));

    // And a hidden other-side member does not make the hidden list shrink
    // either: hiddenMode=only still returns the hidden portrait.
    const hiddenOnly = await listGalleryGridLogic(u, { hiddenMode: "only", variantMode: "landscape" }, grid);
    expect(hiddenOnly.photos.map((p) => p.id)).toEqual([portrait]);
  });

  it("is a per-user view: another user's group never touches my grid", async () => {
    const other = await makeUser("other@test.com");
    const portrait = await makePhoto(u, "portrait", 0);
    const landscape = await makePhoto(u, "landscape", 10);
    await makeGroup(other, portrait, [portrait, landscape]);

    expect(await gridIds(u, "portrait")).toEqual([portrait, landscape].sort((a, b) => a - b));
  });

  it("respects 'off' on the group and the user's global switch", async () => {
    const portrait = await makePhoto(u, "portrait", 0);
    const landscape = await makePhoto(u, "landscape", 10);
    const groupId = await makeGroup(u, portrait, [portrait, landscape]);
    expect(await gridIds(u, "portrait")).toEqual([portrait]);

    await setGroupOrientationVariantsLogic(u, groupId, "off");
    expect(await gridIds(u, "portrait")).toEqual([portrait, landscape].sort((a, b) => a - b));
    const groups = await listPhotoGroupsLogic(u);
    expect(groups.groups[0].orientation_variants).toBe("off");
    expect(groups.groups[0].variants).toBeUndefined();

    await setGroupOrientationVariantsLogic(u, groupId, "auto");
    expect(await gridIds(u, "portrait")).toEqual([portrait]);
    const again = await listPhotoGroupsLogic(u);
    expect(again.groups[0].orientation_variants).toBe("auto");
    expect(again.groups[0].variants).toEqual({
      portrait: 1, landscape: 1, portrait_ids: [portrait], landscape_ids: [landscape],
    });

    expect(await getCollapseOrientationVariantsLogic(u)).toEqual({ enabled: true });
    await setCollapseOrientationVariantsLogic(u, false);
    expect(await getCollapseOrientationVariantsLogic(u)).toEqual({ enabled: false });
    expect(await gridIds(u, "portrait")).toEqual([portrait, landscape].sort((a, b) => a - b));
    await setCollapseOrientationVariantsLogic(u, true);
    expect(await gridIds(u, "portrait")).toEqual([portrait]);
  });

  it("refuses to flip a group that belongs to somebody else", async () => {
    const other = await makeUser("other@test.com");
    const portrait = await makePhoto(u, "portrait", 0);
    const landscape = await makePhoto(u, "landscape", 10);
    const groupId = await makeGroup(u, portrait, [portrait, landscape]);

    await expect(setGroupOrientationVariantsLogic(other, groupId, "off")).rejects.toThrow("group not found");
    const row = await db.select({ m: photoGroups.orientation_variants }).from(photoGroups).where(eq(photoGroups.id, groupId));
    expect(row[0].m).toBeNull();
  });

  it("moves the stack cover to the shown side while the real cover is on the other side", async () => {
    const landscapeCover = await makePhoto(u, "landscape", 0);
    const portraitA = await makePhoto(u, "portrait", 5);
    const portraitB = await makePhoto(u, "portrait", 10);
    await makeGroup(u, landscapeCover, [landscapeCover, portraitA, portraitB]);

    const portraitView = await listGalleryGridLogic(u, { variantMode: "portrait" }, grid);
    const covers = portraitView.photos.filter((p) => p.group?.is_cover).map((p) => p.id);
    // Exactly one cover, and it is the best-ranked portrait frame.
    expect(covers).toEqual([portraitA]);

    const landscapeView = await listGalleryGridLogic(u, { variantMode: "landscape" }, grid);
    expect(landscapeView.photos.filter((p) => p.group?.is_cover).map((p) => p.id)).toEqual([landscapeCover]);

    // "all" leaves the database cover alone.
    const all = await listGalleryGridLogic(u, { variantMode: "all" }, grid);
    expect(all.photos.filter((p) => p.group?.is_cover).map((p) => p.id)).toEqual([landscapeCover]);
  });

  it("puts the orientation on the legacy photo list and the pair flag on the review queue", async () => {
    const portrait = await makePhoto(u, "portrait", 0);
    const landscape = await makePhoto(u, "landscape", 10);
    const unknown = await makePhoto(u, "unknown", 3000);
    await makeGroup(u, portrait, [portrait, landscape]);
    const lonerA = await makePhoto(u, "landscape", 6000);
    const lonerB = await makePhoto(u, "landscape", 6010);
    await makeGroup(u, lonerA, [lonerA, lonerB]);

    const list = await listPhotosLogic(u, {});
    const byId = new Map(list.photos.map((p) => [p.id, p]));
    expect(byId.get(portrait)!.orientation).toBe("portrait");
    expect(byId.get(landscape)!.orientation).toBe("landscape");
    expect(byId.get(unknown)!.orientation).toBeNull();
    // The legacy list honours the filter too.
    const portraitOnly = await listPhotosLogic(u, { variantMode: "portrait" });
    expect(portraitOnly.photos.map((p) => p.id)).not.toContain(landscape);

    const queue = await listReviewQueueLogic(u);
    const pairFlags = new Map(queue.groups.map((g) => [g.id, g.orientation_pair]));
    expect(queue.groups).toHaveLength(2);
    expect([...pairFlags.values()].sort()).toEqual([false, true]);
    const pairGroup = queue.groups.find((g) => g.orientation_pair)!;
    expect(pairGroup.photos.map((p) => p.id).sort((a, b) => a - b)).toEqual([portrait, landscape].sort((a, b) => a - b));
  });

  it("keeps the best frame per orientation, hides the rest and marks the group reviewed", async () => {
    const pA = await makePhoto(u, "portrait", 0);
    const pB = await makePhoto(u, "portrait", 5);
    const lA = await makePhoto(u, "landscape", 10);
    await db.update(photos).set({ ai_quality_score: 0.4 }).where(eq(photos.id, pA));
    await db.update(photos).set({ ai_quality_score: 0.9 }).where(eq(photos.id, pB));
    const groupId = await makeGroup(u, pA, [pA, pB, lA]);

    const res = await keepBestPerOrientationLogic(u, groupId);
    expect(res.success).toBe(true);
    expect(res.kept_photo_ids.sort((a, b) => a - b)).toEqual([pB, lA].sort((a, b) => a - b));
    expect(res.hidden_count).toBe(1);
    const hidden = await db.select({ status: photoCuration.status })
      .from(photoCuration).where(eq(photoCuration.photo_id, pA));
    expect(hidden[0]?.status).toBe("hidden");
    const g = await db.select({ reviewed_at: photoGroups.reviewed_at }).from(photoGroups).where(eq(photoGroups.id, groupId));
    expect(g[0]?.reviewed_at).not.toBeNull();

    // Somebody else's group is not ours to decide.
    const other = await makeUser("other@test.com");
    expect((await keepBestPerOrientationLogic(other, groupId)).success).toBe(false);
  });

  it("filters the review queue down to format pairs", async () => {
    const portrait = await makePhoto(u, "portrait", 0);
    const landscape = await makePhoto(u, "landscape", 10);
    const pairGroup = await makeGroup(u, portrait, [portrait, landscape]);
    const lonerA = await makePhoto(u, "landscape", 6000);
    const lonerB = await makePhoto(u, "landscape", 6010);
    await makeGroup(u, lonerA, [lonerA, lonerB]);
    const farP = await makePhoto(u, "portrait", 9000);
    const farL = await makePhoto(u, "landscape", 9000 + VARIANT_TIME_WINDOW_SECONDS + 1);
    await makeGroup(u, farP, [farP, farL]);

    expect((await listReviewQueueLogic(u)).total).toBe(3);
    const pairs = await listReviewQueueLogic(u, { orientationPair: true });
    expect(pairs.total).toBe(1);
    expect(pairs.groups.map((g) => g.id)).toEqual([pairGroup]);
    expect(pairs.groups[0]!.orientation_pair).toBe(true);

    // "Nicht dasselbe Motiv" takes the group out of the filter.
    await setGroupOrientationVariantsLogic(u, pairGroup, "off");
    expect((await listReviewQueueLogic(u, { orientationPair: true })).total).toBe(0);
  });

  it("names the best-ranked other side per photo for the recap and the stream", async () => {
    const landscape = await makePhoto(u, "landscape", 0);
    const pA = await makePhoto(u, "portrait", 5);
    const pB = await makePhoto(u, "portrait", 10);
    const loner = await makePhoto(u, "landscape", 9000);
    const groupId = await makeGroup(u, landscape, [landscape, pA, pB]);

    const map = await counterpartsByPhotoId(u, [landscape, pA, pB, loner, 999999]);
    expect(map.get(landscape)).toMatchObject({ id: pA, orientation: "portrait", width: 3000, height: 4000 });
    expect(map.get(pA)).toMatchObject({ id: landscape, orientation: "landscape" });
    expect(map.get(pB)?.id).toBe(landscape);
    expect(map.has(loner)).toBe(false);
    expect(map.get(landscape)?.filename).toMatch(/\.jpg$/);

    // Another user's view of my photos: no groups, no counterparts.
    const other = await makeUser("other@test.com");
    expect((await counterpartsByPhotoId(other, [landscape])).size).toBe(0);

    // "Nicht dasselbe Motiv" switches the pair off here as well.
    await setGroupOrientationVariantsLogic(u, groupId, "off");
    expect((await counterpartsByPhotoId(u, [landscape])).size).toBe(0);
    expect((await counterpartsByPhotoId(u, [])).size).toBe(0);
  });
});
