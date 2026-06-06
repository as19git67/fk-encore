import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import db from "../db/database";
import {
  photos,
  albums,
  albumPhotos,
  albumShares,
  photoCuration,
  albumUserSettings,
  photoComments,
  photoFeedEntries,
  users,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as photo from "../photo/photo.service";
import { createComment } from "../photo/reactions.service";
import { listPhotoFeedForUser } from "./feed.service";

/**
 * Etappe 3: content-feed read endpoint (listPhotoFeedForUser). Covers
 * ordering by last_activity_at, viewer isolation, global like count +
 * likedByMe, comment preview, keyset pagination and hidden-photo exclusion.
 */
describe("content feed: listPhotoFeedForUser", () => {
  let owner: any;
  let friend: any;
  let stranger: any;

  beforeEach(async () => {
    await db.delete(photoFeedEntries);
    await db.delete(photoComments);
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(albumUserSettings);
    await db.delete(photoCuration);
    await db.delete(albums);
    await db.delete(photos);
    await db.delete(users);
    owner = await createUserLogic({ email: "owner@test.com", name: "Owner", password: "pw" });
    friend = await createUserLogic({ email: "friend@test.com", name: "Friend", password: "pw" });
    stranger = await createUserLogic({ email: "stranger@test.com", name: "Stranger", password: "pw" });
  });

  let seed = 0;
  async function uploadPhoto(userId: number, name: string) {
    seed += 1;
    return photo.uploadPhotoLogic(userId, { data: Buffer.from([seed, seed + 1, seed + 2, seed + 3]), name, mimeType: "image/jpeg" });
  }

  /** Pin an entry's sort key for deterministic ordering assertions. */
  async function setActivity(userId: number, photoId: number, iso: string) {
    await db.update(photoFeedEntries).set({ last_activity_at: iso })
      .where(and(eq(photoFeedEntries.user_id, userId), eq(photoFeedEntries.photo_id, photoId)));
  }

  it("orders strictly by last_activity_at (newest first)", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p1 = await uploadPhoto(owner.id, "1.jpg");
    const p2 = await uploadPhoto(owner.id, "2.jpg");
    const p3 = await uploadPhoto(owner.id, "3.jpg");
    for (const p of [p1, p2, p3]) {
      await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    }
    await setActivity(owner.id, p1.id, "2021-01-01T00:00:00.000Z");
    await setActivity(owner.id, p2.id, "2023-01-01T00:00:00.000Z");
    await setActivity(owner.id, p3.id, "2022-01-01T00:00:00.000Z");

    const res = await listPhotoFeedForUser(owner.id, {});
    expect(res.items.map((i) => i.photoId)).toEqual([p2.id, p3.id, p1.id]);
    expect(res.nextCursor).toBeNull();
  });

  it("only shows photos the viewer can see", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await uploadPhoto(owner.id, "1.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });

    const ownerFeed = await listPhotoFeedForUser(owner.id, {});
    expect(ownerFeed.items.map((i) => i.photoId)).toEqual([p.id]);

    const strangerFeed = await listPhotoFeedForUser(stranger.id, {});
    expect(strangerFeed.items).toEqual([]);
  });

  it("reports the global like count and likedByMe", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await uploadPhoto(owner.id, "1.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    await photo.shareAlbumLogic(owner.id, { albumId: album.id, userId: friend.id, accessLevel: "read" });

    // Both favorite it → global count 2.
    await photo.updatePhotoCurationLogic(owner.id, p.id, "favorite");
    await photo.updatePhotoCurationLogic(friend.id, p.id, "favorite");

    const ownerFeed = await listPhotoFeedForUser(owner.id, {});
    expect(ownerFeed.items[0].likeCount).toBe(2);
    expect(ownerFeed.items[0].likedByMe).toBe(true);

    // Stranger isn't a participant, but if they were the count is still global.
    const friendFeed = await listPhotoFeedForUser(friend.id, {});
    expect(friendFeed.items[0].likeCount).toBe(2);
    expect(friendFeed.items[0].likedByMe).toBe(true);
  });

  it("includes comment count and the latest comment preview", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await uploadPhoto(owner.id, "1.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    await photo.shareAlbumLogic(owner.id, { albumId: album.id, userId: friend.id, accessLevel: "read" });

    await createComment(owner.id, p.id, "erster", album.id);
    await createComment(friend.id, p.id, "zweiter und neuester", album.id);

    const res = await listPhotoFeedForUser(owner.id, {});
    expect(res.items[0].commentCount).toBe(2);
    expect(res.items[0].latestComment?.excerpt).toBe("zweiter und neuester");
    expect(res.items[0].latestComment?.author).toBe("Friend");
  });

  it("paginates via keyset cursor", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const ps = [];
    for (let i = 0; i < 3; i++) ps.push(await uploadPhoto(owner.id, `${i}.jpg`));
    for (const p of ps) await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    await setActivity(owner.id, ps[0].id, "2021-01-01T00:00:00.000Z");
    await setActivity(owner.id, ps[1].id, "2022-01-01T00:00:00.000Z");
    await setActivity(owner.id, ps[2].id, "2023-01-01T00:00:00.000Z");

    const page1 = await listPhotoFeedForUser(owner.id, { limit: 2 });
    expect(page1.items.map((i) => i.photoId)).toEqual([ps[2].id, ps[1].id]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listPhotoFeedForUser(owner.id, {
      limit: 2,
      cursorTs: page1.nextCursor!.ts,
      cursorId: page1.nextCursor!.id,
    });
    expect(page2.items.map((i) => i.photoId)).toEqual([ps[0].id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("orders a multi-photo upload by capture time (newest capture first)", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p1 = await uploadPhoto(owner.id, "1.jpg");
    const p2 = await uploadPhoto(owner.id, "2.jpg");
    const p3 = await uploadPhoto(owner.id, "3.jpg");
    // Capture order deliberately differs from upload/id order.
    await db.update(photos).set({ taken_at: "2020-01-01 10:00:00" }).where(eq(photos.id, p1.id));
    await db.update(photos).set({ taken_at: "2022-01-01 10:00:00" }).where(eq(photos.id, p2.id));
    await db.update(photos).set({ taken_at: "2021-01-01 10:00:00" }).where(eq(photos.id, p3.id));

    // Batch add (as the feed upload does) staggers last_activity_at by capture.
    await photo.batchUpdateAlbumPhotosLogic(owner.id, {
      albumIds: [album.id],
      photoIds: [p1.id, p2.id, p3.id],
      action: "add",
    });

    const res = await listPhotoFeedForUser(owner.id, {});
    // Newest capture first: p2 (2022) → p3 (2021) → p1 (2020).
    expect(res.items.map((i) => i.photoId)).toEqual([p2.id, p3.id, p1.id]);
  });

  it("excludes photos the viewer has hidden", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p1 = await uploadPhoto(owner.id, "1.jpg");
    const p2 = await uploadPhoto(owner.id, "2.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p1.id });
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p2.id });

    await photo.updatePhotoCurationLogic(owner.id, p1.id, "hidden");

    const res = await listPhotoFeedForUser(owner.id, {});
    expect(res.items.map((i) => i.photoId)).toEqual([p2.id]);
  });
});
