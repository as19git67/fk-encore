import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import { photos, albums, albumPhotos, albumShares, users } from "../db/schema";
import { dbInsertReturning } from "../db/adapter";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";
import { listGalleryGridLogic } from "./gallery-grid.service";

/**
 * Regression cover for the album-detail grid: a non-owner viewing a
 * shared album used to get an empty grid because the grid query was
 * hard-scoped to `photos.user_id = caller`. With `albumScopeId` the grid
 * scopes to album membership (with an access check) instead.
 */
describe("Gallery grid – album scope", () => {
  let owner: any;
  let viewer: any;
  let stranger: any;

  beforeEach(async () => {
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(albums);
    await db.delete(photos);
    await db.delete(users);

    owner = await createUserLogic({ email: "owner@test.com", name: "Owner", password: "pw" });
    viewer = await createUserLogic({ email: "viewer@test.com", name: "Viewer", password: "pw" });
    stranger = await createUserLogic({ email: "stranger@test.com", name: "Stranger", password: "pw" });
  });

  async function makePhoto(userId: number, name: string): Promise<number> {
    const row = await dbInsertReturning<{ id: number }>(
      db
        .insert(photos)
        .values({
          user_id: userId,
          filename: name,
          original_name: name,
          mime_type: "image/jpeg",
          size: 1000,
        })
        .returning({ id: photos.id }),
    );
    return row!.id;
  }

  const opts = { limit: 100, offset: 0, sortBy: "taken_at", sortDir: "asc" } as const;

  it("shows another user's shared album photos in the grid", async () => {
    const album = await service.createAlbumLogic(owner.id, { name: "Trip" });
    const p1 = await makePhoto(owner.id, "a.jpg");
    const p2 = await makePhoto(owner.id, "b.jpg");
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p1 });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p2 });
    await service.shareAlbumLogic(owner.id, {
      albumId: album.id,
      userId: viewer.id,
      accessLevel: "read",
    });

    // Owner sees the album's photos.
    const ownerGrid = await listGalleryGridLogic(owner.id, { albumScopeId: album.id }, opts);
    expect(ownerGrid.total).toBe(2);

    // Shared viewer (non-owner) sees the SAME photos — this was the bug.
    const viewerGrid = await listGalleryGridLogic(viewer.id, { albumScopeId: album.id }, opts);
    expect(viewerGrid.total).toBe(2);
    expect(viewerGrid.photos.map((p) => p.id).sort()).toEqual([p1, p2].sort());

    // A user with no access to the album sees nothing — the access check
    // is baked into the scope subquery, so there is no data leak.
    const strangerGrid = await listGalleryGridLogic(stranger.id, { albumScopeId: album.id }, opts);
    expect(strangerGrid.total).toBe(0);
  });

  it("library grid (no album scope) still only returns the caller's own photos", async () => {
    await makePhoto(owner.id, "owned.jpg");

    const viewerLibrary = await listGalleryGridLogic(viewer.id, {}, opts);
    expect(viewerLibrary.total).toBe(0);

    const ownerLibrary = await listGalleryGridLogic(owner.id, {}, opts);
    expect(ownerLibrary.total).toBe(1);
  });
});
