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
import { listFeedForUser } from "./feed.service";

/**
 * The notification feed item now carries the photo's description so the feed
 * card can show what the photo is about, not just who acted.
 *
 * The fan-out (`feed.emitFeed`) is an Encore RPC that only runs under
 * `encore test`; in plain vitest we seed a feed_items row directly and assert
 * the read path (listFeedForUser) joins the description in.
 */
describe("notification feed: photo description in FeedItem", () => {
  let owner: any;
  let viewer: any;

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
  });

  async function seedPhoto(description: string | null) {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await photo.uploadPhotoLogic(owner.id, {
      data: Buffer.from([Math.floor(Math.random() * 250), 1, 2, 3]), name: "a.jpg", mimeType: "image/jpeg",
    });
    if (description !== null) {
      await photo.updatePhotoDescriptionLogic(owner.id, p.id, description);
    }
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    await db.insert(feedItems).values({
      user_id: viewer.id,
      actor_user_id: owner.id,
      kind: "photo_commented",
      album_id: album.id,
      photo_id: p.id,
      payload: {},
    });
    return p;
  }

  it("includes the photo description in the feed item", async () => {
    const p = await seedPhoto("Sonnenuntergang am Meer");
    const feed = await listFeedForUser(viewer.id, {});
    const item = feed.items.find((i) => i.photo?.id === p.id);
    expect(item).toBeDefined();
    expect(item!.photo?.description).toBe("Sonnenuntergang am Meer");
  });

  it("leaves description null when the photo has none", async () => {
    const p = await seedPhoto(null);
    const feed = await listFeedForUser(viewer.id, {});
    const item = feed.items.find((i) => i.photo?.id === p.id);
    expect(item!.photo?.description).toBeNull();
  });
});
