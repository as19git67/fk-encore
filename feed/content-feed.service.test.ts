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

/**
 * Etappe 2: content-feed fan-out / reconcile. Drives the real photo/album
 * mutations and asserts the materialized photo_feed_entries table stays in
 * sync — viewer-accurate (variant B), monotonic bumps, likes never bump.
 */
describe("content feed: photo_feed_entries maintenance", () => {
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

  let photoSeed = 0;
  async function uploadPhoto(userId: number, name: string) {
    // Unique bytes per upload so content-hash dedup doesn't collapse them.
    photoSeed += 1;
    return photo.uploadPhotoLogic(userId, { data: Buffer.from([photoSeed, photoSeed + 1, photoSeed + 2, photoSeed + 3]), name, mimeType: "image/jpeg" });
  }

  async function viewersOf(photoId: number): Promise<number[]> {
    const rows = await db.select({ user_id: photoFeedEntries.user_id })
      .from(photoFeedEntries)
      .where(eq(photoFeedEntries.photo_id, photoId));
    return rows.map((r) => r.user_id).sort((a, b) => a - b);
  }

  async function entryTs(userId: number, photoId: number): Promise<string | null> {
    const rows = await db.select({ ts: photoFeedEntries.last_activity_at })
      .from(photoFeedEntries)
      .where(and(eq(photoFeedEntries.user_id, userId), eq(photoFeedEntries.photo_id, photoId)));
    return rows[0]?.ts ?? null;
  }

  /** Force an entry's timestamp to a known-old value for deterministic bump assertions. */
  async function backdate(userId: number, photoId: number, iso = "2000-01-01T00:00:00.000Z") {
    await db.update(photoFeedEntries)
      .set({ last_activity_at: iso })
      .where(and(eq(photoFeedEntries.user_id, userId), eq(photoFeedEntries.photo_id, photoId)));
  }

  it("adds an entry for the owner when a photo enters their own album", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await uploadPhoto(owner.id, "a.jpg");
    expect(await viewersOf(p.id)).toEqual([]); // not in any album yet

    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    expect(await viewersOf(p.id)).toEqual([owner.id]);
  });

  it("fans out to all participants when the album is shared, and seeds on share", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await uploadPhoto(owner.id, "a.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });

    // Sharing seeds the existing photo for the new participant.
    await photo.shareAlbumLogic(owner.id, { albumId: album.id, userId: friend.id, accessLevel: "read" });
    expect(await viewersOf(p.id)).toEqual([owner.id, friend.id].sort((a, b) => a - b));

    // A subsequent add bumps both participants.
    const p2 = await uploadPhoto(owner.id, "b.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p2.id });
    expect(await viewersOf(p2.id)).toEqual([owner.id, friend.id].sort((a, b) => a - b));

    // The stranger never participates.
    expect(await viewersOf(p.id)).not.toContain(stranger.id);
  });

  it("bumps participants on a comment (viewer-accurate)", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await uploadPhoto(owner.id, "a.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    await photo.shareAlbumLogic(owner.id, { albumId: album.id, userId: friend.id, accessLevel: "read" });

    await backdate(owner.id, p.id);
    await backdate(friend.id, p.id);

    await createComment(friend.id, p.id, "schönes Foto", album.id);

    expect(new Date(await entryTs(owner.id, p.id) as string).getTime()).toBeGreaterThan(new Date("2000-01-01").getTime());
    expect(new Date(await entryTs(friend.id, p.id) as string).getTime()).toBeGreaterThan(new Date("2000-01-01").getTime());
  });

  it("bumps every viewer on a metadata edit", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await uploadPhoto(owner.id, "a.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    await photo.shareAlbumLogic(owner.id, { albumId: album.id, userId: friend.id, accessLevel: "read" });

    await backdate(owner.id, p.id);
    await backdate(friend.id, p.id);

    await photo.updatePhotoDescriptionLogic(owner.id, p.id, "Neue Beschreibung");

    expect(new Date(await entryTs(owner.id, p.id) as string).getTime()).toBeGreaterThan(new Date("2000-01-01").getTime());
    expect(new Date(await entryTs(friend.id, p.id) as string).getTime()).toBeGreaterThan(new Date("2000-01-01").getTime());
  });

  it("does NOT bump on like/favorite", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await uploadPhoto(owner.id, "a.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    await photo.shareAlbumLogic(owner.id, { albumId: album.id, userId: friend.id, accessLevel: "read" });

    const old = "2000-01-01T00:00:00.000Z";
    await backdate(owner.id, p.id, old);
    await backdate(friend.id, p.id, old);

    await photo.updatePhotoCurationLogic(friend.id, p.id, "favorite");

    // Likes never reorder the feed — timestamps stay put.
    expect(new Date(await entryTs(owner.id, p.id) as string).getTime()).toBe(new Date(old).getTime());
    expect(new Date(await entryTs(friend.id, p.id) as string).getTime()).toBe(new Date(old).getTime());
  });

  it("bumps are monotonic — never lowered", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await uploadPhoto(owner.id, "a.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });

    const future = "2999-01-01T00:00:00.000Z";
    await db.update(photoFeedEntries).set({ last_activity_at: future })
      .where(and(eq(photoFeedEntries.user_id, owner.id), eq(photoFeedEntries.photo_id, p.id)));

    // A real (earlier) comment must not pull the far-future value back.
    await createComment(owner.id, p.id, "kommentar", album.id);
    expect(new Date(await entryTs(owner.id, p.id) as string).getTime()).toBe(new Date(future).getTime());
  });

  it("removing a photo from its only album drops all entries", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await uploadPhoto(owner.id, "a.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    await photo.shareAlbumLogic(owner.id, { albumId: album.id, userId: friend.id, accessLevel: "read" });
    expect((await viewersOf(p.id)).length).toBe(2);

    await photo.batchUpdateAlbumPhotosLogic(owner.id, { albumIds: [album.id], photoIds: [p.id], action: "remove" });
    expect(await viewersOf(p.id)).toEqual([]);
  });

  it("removing from one album keeps the entry when the photo lives in another shared album", async () => {
    const a1 = await photo.createAlbumLogic(owner.id, { name: "A1" });
    const a2 = await photo.createAlbumLogic(owner.id, { name: "A2" });
    const p = await uploadPhoto(owner.id, "a.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: a1.id, photoId: p.id });
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: a2.id, photoId: p.id });
    await photo.shareAlbumLogic(owner.id, { albumId: a1.id, userId: friend.id, accessLevel: "read" });
    await photo.shareAlbumLogic(owner.id, { albumId: a2.id, userId: friend.id, accessLevel: "read" });

    await photo.batchUpdateAlbumPhotosLogic(owner.id, { albumIds: [a1.id], photoIds: [p.id], action: "remove" });
    // Still visible via a2 for both.
    expect(await viewersOf(p.id)).toEqual([owner.id, friend.id].sort((a, b) => a - b));
  });

  it("unsharing drops the unshared user's entry but keeps it if seen via another album", async () => {
    const a1 = await photo.createAlbumLogic(owner.id, { name: "A1" });
    const p = await uploadPhoto(owner.id, "a.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: a1.id, photoId: p.id });
    await photo.shareAlbumLogic(owner.id, { albumId: a1.id, userId: friend.id, accessLevel: "read" });
    expect((await viewersOf(p.id)).length).toBe(2);

    await photo.removeAlbumShareLogic(owner.id, { albumId: a1.id, userId: friend.id });
    expect(await viewersOf(p.id)).toEqual([owner.id]);
  });

  it("leaving an album drops the leaver's entries", async () => {
    const a1 = await photo.createAlbumLogic(owner.id, { name: "A1" });
    const p = await uploadPhoto(owner.id, "a.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: a1.id, photoId: p.id });
    await photo.shareAlbumLogic(owner.id, { albumId: a1.id, userId: friend.id, accessLevel: "read" });

    await photo.leaveAlbumLogic(friend.id, a1.id);
    expect(await viewersOf(p.id)).toEqual([owner.id]);
  });

  it("deleting an album with multiple photos drops all entries and is idempotent", async () => {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p1 = await uploadPhoto(owner.id, "a.jpg");
    const p2 = await uploadPhoto(owner.id, "b.jpg");
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p1.id });
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p2.id });
    await photo.shareAlbumLogic(owner.id, { albumId: album.id, userId: friend.id, accessLevel: "read" });
    expect((await viewersOf(p1.id)).length).toBe(2);
    expect((await viewersOf(p2.id)).length).toBe(2);

    await photo.deleteAlbumLogic(owner.id, album.id);
    expect(await viewersOf(p1.id)).toEqual([]);
    expect(await viewersOf(p2.id)).toEqual([]);

    await expect(photo.deleteAlbumLogic(owner.id, album.id)).resolves.toEqual({
      success: true,
      message: "Album deleted",
    });
  });
});
