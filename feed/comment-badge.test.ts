import { describe, it, expect, beforeEach } from "vitest";
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
  feedItems,
  users,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as photo from "../photo/photo.service";
import { countUnread, countUnreadComments, markSeenForUser } from "./feed.service";

/**
 * The home-screen badge counts unread comments by *other people*, and nothing
 * else — it used to carry the number of unreviewed similar-photo groups, a
 * count that never reaches zero on its own.
 *
 * `countUnread` (every kind, drives the in-app Feed tab) stays as it was; the
 * two are asserted side by side so a future change cannot quietly merge them.
 */
describe("feed: unread-comment count for the app badge", () => {
  let owner: any;
  let viewer: any;
  let album: any;
  let subject: any;

  beforeEach(async () => {
    await db.delete(feedItems);
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
    viewer = await createUserLogic({ email: "viewer@test.com", name: "Viewer", password: "pw" });
    album = await photo.createAlbumLogic(owner.id, { name: "A" });
    subject = await photo.uploadPhotoLogic(owner.id, {
      data: Buffer.from([7, 1, 2, 3]), name: "a.jpg", mimeType: "image/jpeg",
    });
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: subject.id });
  });

  /** One feed row for `viewer`, as the fan-out would write it. */
  async function seedItem(
    kind: "photo_commented" | "photo_favorited" | "photo_added",
    actorUserId: number | null,
  ) {
    await db.insert(feedItems).values({
      user_id: viewer.id,
      actor_user_id: actorUserId,
      kind,
      album_id: album.id,
      photo_id: subject.id,
      payload: {},
    });
  }

  it("counts an unread comment written by somebody else", async () => {
    await seedItem("photo_commented", owner.id);
    expect(await countUnreadComments(viewer.id)).toBe(1);
  });

  it("ignores the viewer's own comments", async () => {
    await seedItem("photo_commented", viewer.id);
    expect(await countUnreadComments(viewer.id)).toBe(0);
  });

  /// A public-link visitor has no user id, and is still somebody else.
  it("counts a guest's comment, which has no actor", async () => {
    await seedItem("photo_commented", null);
    expect(await countUnreadComments(viewer.id)).toBe(1);
  });

  it("counts only comments — favourites and uploads stay off the badge", async () => {
    await seedItem("photo_commented", owner.id);
    await seedItem("photo_favorited", owner.id);
    await seedItem("photo_added", owner.id);

    expect(await countUnreadComments(viewer.id)).toBe(1);
    // The in-app Feed tab still counts all three.
    expect(await countUnread(viewer.id)).toBe(3);
  });

  it("drops to zero once the feed is marked seen", async () => {
    await seedItem("photo_commented", owner.id);
    const [row] = await db.select({ id: feedItems.id }).from(feedItems);
    await markSeenForUser(viewer.id, { upToId: row!.id });
    expect(await countUnreadComments(viewer.id)).toBe(0);
  });

  it("does not count comments addressed to somebody else", async () => {
    await db.insert(feedItems).values({
      user_id: owner.id,
      actor_user_id: viewer.id,
      kind: "photo_commented",
      album_id: album.id,
      photo_id: subject.id,
      payload: {},
    });
    expect(await countUnreadComments(viewer.id)).toBe(0);
  });
});
