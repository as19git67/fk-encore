import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import {
  albumPhotos,
  albumShares,
  albumUserSettings,
  albums,
  photoCuration,
  photoGroupMembers,
  photoGroups,
  photos,
  users,
} from "../db/schema";
import {
  revertAdoptionForUser,
  runAdoptionForUser,
  scheduleAdoptionForPeers,
  setAdoptionDefaultLogic,
} from "./group-review-adoption.service";
import { updatePhotoCurationLogic } from "./photo.service";

async function makeUser(email: string, adopt = true): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(users).values({
      email,
      name: "Test",
      password_hash: "x",
      adopt_group_reviews: adopt,
    }).returning({ id: users.id }),
  );
  return row!.id;
}

async function makePhoto(userId: number): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(photos).values({
      user_id: userId,
      filename: `p-${Math.random().toString(36).slice(2)}.jpg`,
      original_name: "p.jpg",
      mime_type: "image/jpeg",
      size: 1000,
    }).returning({ id: photos.id }),
  );
  return row!.id;
}

async function makeGroup(
  userId: number,
  memberIds: number[],
  opts: { reviewedBy?: "user" | "adopted" } = {},
): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(photoGroups).values({
      user_id: userId,
      cover_photo_id: memberIds[0]!,
      reviewed_at: opts.reviewedBy ? new Date().toISOString() : null,
      review_source: opts.reviewedBy ?? null,
    }).returning({ id: photoGroups.id }),
  );
  const groupId = row!.id;
  for (let i = 0; i < memberIds.length; i++) {
    await dbExec(
      db.insert(photoGroupMembers).values({
        group_id: groupId,
        photo_id: memberIds[i]!,
        similarity_rank: i,
      }),
    );
  }
  return groupId;
}

async function makeSharedAlbum(ownerId: number, withUserIds: number[], photoIds: number[]): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(albums).values({ user_id: ownerId, name: "Shared" }).returning({ id: albums.id }),
  );
  const albumId = row!.id;
  for (const uid of withUserIds) {
    await dbExec(db.insert(albumShares).values({ album_id: albumId, user_id: uid, access_level: "read" }));
  }
  for (const pid of photoIds) {
    await dbExec(db.insert(albumPhotos).values({ album_id: albumId, photo_id: pid }));
  }
  return albumId;
}

async function setCuration(
  userId: number,
  photoId: number,
  status: "visible" | "hidden" | "favorite",
  source: "user" | "adopted" = "user",
): Promise<void> {
  await dbExec(db.insert(photoCuration).values({ user_id: userId, photo_id: photoId, status, source }));
}

async function curationOf(userId: number, photoId: number) {
  return dbFirst<{ status: string; source: string }>(
    db.select({ status: photoCuration.status, source: photoCuration.source })
      .from(photoCuration)
      .where(and(eq(photoCuration.user_id, userId), eq(photoCuration.photo_id, photoId))),
  );
}

async function groupOf(groupId: number) {
  return dbFirst<{ reviewed_at: string | null; review_source: string | null }>(
    db.select({ reviewed_at: photoGroups.reviewed_at, review_source: photoGroups.review_source })
      .from(photoGroups)
      .where(eq(photoGroups.id, groupId)),
  );
}

/**
 * The household in every test below: `reviewer` works through the stacks,
 * `passive` does not, and both see the same three photos through a shared
 * album. Returns the photo ids plus the passive user's open group.
 */
async function household(opts: { adopt?: boolean } = {}) {
  const reviewer = await makeUser(`reviewer-${Math.random()}@test.com`);
  const passive = await makeUser(`passive-${Math.random()}@test.com`, opts.adopt ?? true);
  const p1 = await makePhoto(reviewer);
  const p2 = await makePhoto(reviewer);
  const p3 = await makePhoto(reviewer);
  const albumId = await makeSharedAlbum(reviewer, [passive], [p1, p2, p3]);
  const passiveGroup = await makeGroup(passive, [p1, p2, p3]);
  return { reviewer, passive, p1, p2, p3, albumId, passiveGroup };
}

beforeEach(async () => {
  await db.delete(photoCuration);
  await db.delete(photoGroupMembers);
  await db.delete(photoGroups);
  await db.delete(albumPhotos);
  await db.delete(albumShares);
  await db.delete(albumUserSettings);
  await db.delete(albums);
  await db.delete(photos);
  await db.delete(users);
});

describe("runAdoptionForUser", () => {
  it("adopts the reviewer's result and closes the passive user's group", async () => {
    const h = await household();
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    const res = await runAdoptionForUser(h.passive);

    expect(res.groups_adopted).toBe(1);
    expect(res.photos_hidden).toBe(1);
    expect((await curationOf(h.passive, h.p2))?.status).toBe("hidden");
    expect((await curationOf(h.passive, h.p2))?.source).toBe("adopted");
    expect(await curationOf(h.passive, h.p1)).toBeUndefined();
    const g = await groupOf(h.passiveGroup);
    expect(g?.reviewed_at).toBeTruthy();
    expect(g?.review_source).toBe("adopted");
  });

  it("is idempotent", async () => {
    const h = await household();
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    await runAdoptionForUser(h.passive);
    const second = await runAdoptionForUser(h.passive);

    // The group is closed now, so the second pass has nothing left to see.
    expect(second.groups_adopted).toBe(0);
    expect(second.photos_hidden).toBe(0);
  });

  it("lets a peer favorite veto the hide", async () => {
    const h = await household();
    const third = await makeUser(`third-${Math.random()}@test.com`);
    await dbExec(db.insert(albumShares).values({ album_id: h.albumId, user_id: third, access_level: "read" }));
    await setCuration(h.reviewer, h.p2, "hidden");
    await setCuration(third, h.p2, "favorite");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });
    await makeGroup(third, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    await runAdoptionForUser(h.passive);

    expect(await curationOf(h.passive, h.p2)).toBeUndefined();
    expect((await groupOf(h.passiveGroup))?.review_source).toBe("adopted");
  });

  it("never overwrites the user's own decision", async () => {
    const h = await household();
    await setCuration(h.passive, h.p2, "favorite");
    await setCuration(h.reviewer, h.p2, "hidden");
    await setCuration(h.reviewer, h.p3, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    await runAdoptionForUser(h.passive);

    const own = await curationOf(h.passive, h.p2);
    expect(own?.status).toBe("favorite");
    expect(own?.source).toBe("user");
    expect((await curationOf(h.passive, h.p3))?.source).toBe("adopted");
  });

  it("leaves a group open when adoption would drop it below two visible members", async () => {
    const h = await household();
    await setCuration(h.reviewer, h.p2, "hidden");
    await setCuration(h.reviewer, h.p3, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    const res = await runAdoptionForUser(h.passive);

    expect(res.groups_skipped).toBe(1);
    expect(res.groups_adopted).toBe(0);
    expect(await curationOf(h.passive, h.p2)).toBeUndefined();
    expect((await groupOf(h.passiveGroup))?.reviewed_at).toBeNull();
  });

  it("ignores a peer group that does not cover the whole group", async () => {
    const h = await household();
    await setCuration(h.reviewer, h.p2, "hidden");
    // The reviewer only ever saw two of the three photos, so there is no
    // decision about the third to adopt.
    await makeGroup(h.reviewer, [h.p1, h.p2], { reviewedBy: "user" });

    const res = await runAdoptionForUser(h.passive);

    expect(res.groups_adopted).toBe(0);
    expect((await groupOf(h.passiveGroup))?.reviewed_at).toBeNull();
  });

  it("does not cascade an adopted review on to a third user", async () => {
    const h = await household();
    const third = await makeUser(`third-${Math.random()}@test.com`);
    await dbExec(db.insert(albumShares).values({ album_id: h.albumId, user_id: third, access_level: "read" }));
    await setCuration(h.reviewer, h.p2, "hidden", "adopted");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "adopted" });
    const thirdGroup = await makeGroup(third, [h.p1, h.p2, h.p3]);

    const res = await runAdoptionForUser(third);

    expect(res.groups_adopted).toBe(0);
    expect((await groupOf(thirdGroup))?.reviewed_at).toBeNull();
  });

  it("ignores a reviewer who no longer shares an album with the user", async () => {
    const h = await household();
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });
    await dbExec(db.delete(albumShares).where(eq(albumShares.album_id, h.albumId)));

    const res = await runAdoptionForUser(h.passive);

    expect(res.groups_adopted).toBe(0);
  });

  it("does nothing when the user turned adoption off globally", async () => {
    const h = await household({ adopt: false });
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    const res = await runAdoptionForUser(h.passive);

    expect(res.groups_adopted).toBe(0);
    expect((await groupOf(h.passiveGroup))?.reviewed_at).toBeNull();
  });

  it("lets a per-album override switch adoption off for that album's groups", async () => {
    const h = await household();
    await dbExec(db.insert(albumUserSettings).values({
      album_id: h.albumId,
      user_id: h.passive,
      group_review_adoption: "off",
    }));
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    const res = await runAdoptionForUser(h.passive);

    expect(res.groups_adopted).toBe(0);
  });

  it("lets a per-album override switch adoption on despite the global default", async () => {
    const h = await household({ adopt: false });
    await dbExec(db.insert(albumUserSettings).values({
      album_id: h.albumId,
      user_id: h.passive,
      group_review_adoption: "on",
    }));
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    const res = await runAdoptionForUser(h.passive);

    expect(res.groups_adopted).toBe(1);
  });
});

describe("mixed mode — disagreeing with an adopted hide", () => {
  it("keeps the photo visible across later passes", async () => {
    const h = await household();
    await setCuration(h.reviewer, h.p2, "hidden");
    const reviewerGroup = await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });
    await runAdoptionForUser(h.passive);
    expect((await curationOf(h.passive, h.p2))?.source).toBe("adopted");

    // The passive user disagrees and brings the photo back.
    await updatePhotoCurationLogic(h.passive, h.p2, "visible");

    const row = await curationOf(h.passive, h.p2);
    expect(row?.status).toBe("visible");
    expect(row?.source).toBe("user");

    // A fresh group (the stack was recomputed) must not hide it again.
    await dbExec(db.delete(photoGroups).where(eq(photoGroups.id, h.passiveGroup)));
    const freshGroup = await makeGroup(h.passive, [h.p1, h.p2, h.p3]);
    await runAdoptionForUser(h.passive);

    expect((await curationOf(h.passive, h.p2))?.status).toBe("visible");
    expect((await groupOf(freshGroup))?.review_source).toBe("adopted");
    expect(reviewerGroup).toBeTruthy();
  });
});

describe("revertAdoptionForUser", () => {
  it("restores the photos and reopens the groups", async () => {
    const h = await household();
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });
    await runAdoptionForUser(h.passive);

    const res = await revertAdoptionForUser(h.passive);

    expect(res.groups_reopened).toBe(1);
    expect(res.photos_restored).toBe(1);
    expect(await curationOf(h.passive, h.p2)).toBeUndefined();
    const g = await groupOf(h.passiveGroup);
    expect(g?.reviewed_at).toBeNull();
    expect(g?.review_source).toBeNull();
  });

  it("leaves the user's own reviews and rows alone", async () => {
    const h = await household();
    await setCuration(h.passive, h.p3, "hidden");
    const ownGroup = await makeGroup(h.passive, [h.p1, h.p2], { reviewedBy: "user" });

    const res = await revertAdoptionForUser(h.passive);

    expect(res.groups_reopened).toBe(0);
    expect((await curationOf(h.passive, h.p3))?.status).toBe("hidden");
    expect((await groupOf(ownGroup))?.reviewed_at).toBeTruthy();
  });
});

describe("consensus counters", () => {
  it("does not count adopted rows as a second voice", async () => {
    const h = await household();
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });
    await runAdoptionForUser(h.passive);

    const rows = await dbAll<{ c: number }>(
      db.select({ c: photoCuration.user_id })
        .from(photoCuration)
        .where(and(eq(photoCuration.photo_id, h.p2), eq(photoCuration.source, "user"))),
    );
    // Two users hide the photo now, but only one of them decided so.
    expect(rows.length).toBe(1);
  });
});

describe("triggers and settings", () => {
  it("fans a finished review out to the peers who share the photos", async () => {
    const h = await household();
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    await scheduleAdoptionForPeers(h.reviewer, [h.p1, h.p2, h.p3]);

    expect((await groupOf(h.passiveGroup))?.review_source).toBe("adopted");
    expect((await curationOf(h.passive, h.p2))?.source).toBe("adopted");
  });

  it("does not schedule the actor's own library", async () => {
    // The reviewer's own group stays theirs — the fan-out is for the others.
    const h = await household();
    const ownOpenGroup = await makeGroup(h.reviewer, [h.p1, h.p2, h.p3]);
    await setCuration(h.passive, h.p2, "hidden");
    await makeGroup(h.passive, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    await scheduleAdoptionForPeers(h.reviewer, [h.p1, h.p2, h.p3]);

    // The passive user's review does reach the reviewer (they are a peer of
    // each other), but only because the fan-out excluded the actor and ran
    // for everyone else — here that set does not contain the reviewer.
    expect((await groupOf(ownOpenGroup))?.reviewed_at).toBeNull();
  });

  it("switching the global default off gives the adopted stacks back", async () => {
    const h = await household();
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });
    await runAdoptionForUser(h.passive);

    await setAdoptionDefaultLogic(h.passive, false);

    expect(await curationOf(h.passive, h.p2)).toBeUndefined();
    const g = await groupOf(h.passiveGroup);
    expect(g?.reviewed_at).toBeNull();
    expect(g?.review_source).toBeNull();
  });

  it("switching the global default back on closes what the peers answered", async () => {
    const h = await household({ adopt: false });
    await setCuration(h.reviewer, h.p2, "hidden");
    await makeGroup(h.reviewer, [h.p1, h.p2, h.p3], { reviewedBy: "user" });

    const res = await setAdoptionDefaultLogic(h.passive, true);

    expect(res.enabled).toBe(true);
    expect((await groupOf(h.passiveGroup))?.review_source).toBe("adopted");
  });
});
