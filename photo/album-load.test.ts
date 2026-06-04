import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { photos, albums, albumPhotos, albumShares, photoCuration, albumUserSettings, users } from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";

/**
 * Covers the album-detail load split: getAlbumLogic({ includePhotos: false })
 * (the fast metadata path) must agree with the full load on count / date span
 * / cover, and getAlbumPhotosLogic must return the same photo set the full
 * load embeds. Also pins filter consistency between the two paths.
 */
describe("album load: metadata path + photos endpoint", () => {
  let user: any;

  beforeEach(async () => {
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(albumUserSettings);
    await db.delete(photoCuration);
    await db.delete(albums);
    await db.delete(photos);
    await db.delete(users);
    user = await createUserLogic({ email: "album@test.com", name: "U", password: "pw" });
  });

  async function seedAlbumWithPhotos() {
    const album = await service.createAlbumLogic(user.id, { name: "A" });
    const p1 = await service.uploadPhotoLogic(user.id, { data: Buffer.from([1]), name: "a.jpg", mimeType: "image/jpeg" });
    const p2 = await service.uploadPhotoLogic(user.id, { data: Buffer.from([2]), name: "b.jpg", mimeType: "image/jpeg" });
    await db.update(photos).set({ taken_at: "2020-01-01 10:00:00" }).where(eq(photos.id, p1.id));
    await db.update(photos).set({ taken_at: "2023-01-01 10:00:00" }).where(eq(photos.id, p2.id));
    await service.addPhotoToAlbumLogic(user.id, { albumId: album.id, photoId: p1.id });
    await service.addPhotoToAlbumLogic(user.id, { albumId: album.id, photoId: p2.id });
    return { album, p1, p2 };
  }

  it("meta path matches the full load on count/dates/cover but omits photos", async () => {
    const { album, p2 } = await seedAlbumWithPhotos();
    const full = await service.getAlbumLogic(user.id, album.id);
    const meta = await service.getAlbumLogic(user.id, album.id, { includePhotos: false });

    expect(meta.photos).toEqual([]);
    expect(meta.photo_count).toBe(full.photo_count);
    expect(meta.photo_count).toBe(2);
    expect(meta.newest_photo_at).toBe(full.newest_photo_at);
    expect(meta.oldest_photo_at).toBe(full.oldest_photo_at);
    expect(meta.cover_filename).toBe(full.cover_filename);
    expect(meta.cover_filename).toBe(p2.filename); // newest visible photo
  });

  it("getAlbumPhotosLogic returns the same photos as the full load", async () => {
    const { album } = await seedAlbumWithPhotos();
    const full = await service.getAlbumLogic(user.id, album.id);
    const { photos: only } = await service.getAlbumPhotosLogic(user.id, album.id);
    expect(only.map((p) => p.id).sort()).toEqual(full.photos.map((p) => p.id).sort());
  });

  it("excludes the viewer's hidden photo consistently across both paths", async () => {
    const { album, p1 } = await seedAlbumWithPhotos();
    await service.updatePhotoCurationLogic(user.id, p1.id, "hidden");

    const meta = await service.getAlbumLogic(user.id, album.id, { includePhotos: false });
    const full = await service.getAlbumLogic(user.id, album.id);

    expect(meta.photo_count).toBe(1);
    expect(full.photos).toHaveLength(1);
    expect(full.photos[0]!.id).not.toBe(p1.id);
    // Cover falls back to the newest *visible* photo in both paths.
    expect(meta.cover_filename).toBe(full.cover_filename);
  });
});
