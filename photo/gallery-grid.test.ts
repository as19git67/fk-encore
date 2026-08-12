import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import {
  photos,
  albums,
  albumPhotos,
  albumShares,
  users,
  photoGroups,
  photoGroupMembers,
  photoCuration,
  photoComments,
} from "../db/schema";
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
    await db.delete(photoComments);
    await db.delete(photoGroupMembers);
    await db.delete(photoGroups);
    await db.delete(photoCuration);
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

  it("counts hidden-only results and the complete library consistently", async () => {
    const visible = await makePhoto(owner.id, "visible.jpg");
    const hiddenA = await makePhoto(owner.id, "hidden-a.jpg");
    const hiddenB = await makePhoto(owner.id, "hidden-b.jpg");
    await db.insert(photoCuration).values([
      { user_id: owner.id, photo_id: hiddenA, status: "hidden" },
      { user_id: owner.id, photo_id: hiddenB, status: "hidden" },
    ]);

    const hiddenOnly = await listGalleryGridLogic(owner.id, { hiddenMode: "only" }, opts);
    expect(hiddenOnly.total).toBe(2);
    expect(hiddenOnly.photos.map((p) => p.id).sort()).toEqual([hiddenA, hiddenB].sort());

    // This is the denominator for "n von m": include both manual hides
    // and AI auto-hides so every active filter is a subset of m.
    const completeLibrary = await listGalleryGridLogic(
      owner.id,
      { hiddenMode: "include", aiHiddenMode: "include" },
      opts,
    );
    expect(completeLibrary.total).toBe(3);
    expect(completeLibrary.photos.map((p) => p.id).sort())
      .toEqual([visible, hiddenA, hiddenB].sort());
  });

  it("reports album-scoped comment counts on grid entries (badge data)", async () => {
    const albumA = await service.createAlbumLogic(owner.id, { name: "A" });
    const albumB = await service.createAlbumLogic(owner.id, { name: "B" });
    const p1 = await makePhoto(owner.id, "c1.jpg");
    const p2 = await makePhoto(owner.id, "c2.jpg");
    for (const albumId of [albumA.id, albumB.id]) {
      await service.addPhotoToAlbumLogic(owner.id, { albumId, photoId: p1 });
      await service.addPhotoToAlbumLogic(owner.id, { albumId, photoId: p2 });
    }
    // Two comments on p1 in album A, one comment on p1 in album B, none on p2.
    await db.insert(photoComments).values([
      { photo_id: p1, album_id: albumA.id, user_id: owner.id, body: "hi" },
      { photo_id: p1, album_id: albumA.id, user_id: owner.id, body: "again" },
      { photo_id: p1, album_id: albumB.id, user_id: owner.id, body: "other album" },
    ]);

    const gridA = await listGalleryGridLogic(owner.id, { albumScopeId: albumA.id }, opts);
    const a1 = gridA.photos.find((p) => p.id === p1)!;
    const a2 = gridA.photos.find((p) => p.id === p2)!;
    expect(a1.comment_count).toBe(2);
    // Photos without comments carry no count (badge stays off).
    expect(a2.comment_count).toBeUndefined();

    // Comments are album-scoped: album B only sees its own single comment.
    const gridB = await listGalleryGridLogic(owner.id, { albumScopeId: albumB.id }, opts);
    expect(gridB.photos.find((p) => p.id === p1)!.comment_count).toBe(1);

    // The library grid (no album scope) never carries comment counts.
    const library = await listGalleryGridLogic(owner.id, {}, opts);
    expect(library.photos.every((p) => p.comment_count === undefined)).toBe(true);
  });

  it("library grid keeps high-confidence AI-pick duplicates visible by default; aiHiddenMode=exclude still hides them", async () => {
    const album = await service.createAlbumLogic(owner.id, { name: "Burst" });
    const pick = await makePhoto(owner.id, "pick.jpg");
    const dup = await makePhoto(owner.id, "dup.jpg");
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: pick });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: dup });

    // A high-confidence, unreviewed AI-picked similar-photo group: `dup`
    // is a non-pick member. Per docs/auto-pick-face-relevance.md §6 this
    // no longer auto-hides `dup` by default — the offline replay found
    // too weak a lift (+7.8pp at 75.6% hit rate) to hide unattended.
    const group = await dbInsertReturning<{ id: number }>(
      db
        .insert(photoGroups)
        .values({
          user_id: owner.id,
          cover_photo_id: pick,
          ai_picked_photo_ids: [pick],
          ai_picked_at: new Date().toISOString(),
          ai_picked_confidence: "high",
        })
        .returning({ id: photoGroups.id }),
    );
    await db.insert(photoGroupMembers).values([
      { group_id: group!.id, photo_id: pick, similarity_rank: 0 },
      { group_id: group!.id, photo_id: dup, similarity_rank: 1 },
    ]);

    // Library grid: default is "include" — no auto-hide.
    const library = await listGalleryGridLogic(owner.id, {}, opts);
    expect(library.total).toBe(2);
    expect(library.photos.map((p) => p.id).sort()).toEqual([dup, pick].sort());

    // aiHiddenMode=exclude remains available for callers that still want
    // the old behavior.
    const excluded = await listGalleryGridLogic(
      owner.id,
      { aiHiddenMode: "exclude" },
      opts,
    );
    expect(excluded.photos.map((p) => p.id)).toEqual([pick]);

    // The global "n von m" denominator deliberately includes the AI-pick
    // runner-up as well, so filters that reveal them can never exceed m.
    const completeLibrary = await listGalleryGridLogic(
      owner.id,
      { hiddenMode: "include", aiHiddenMode: "include" },
      opts,
    );
    expect(completeLibrary.total).toBe(2);
    expect(completeLibrary.photos.map((p) => p.id).sort()).toEqual([dup, pick].sort());

    // Album-detail grid: an album is a curated collection — every album
    // photo is shown, the AI auto-hide does not apply.
    const albumGrid = await listGalleryGridLogic(owner.id, { albumScopeId: album.id }, opts);
    expect(albumGrid.total).toBe(2);
    expect(albumGrid.photos.map((p) => p.id).sort()).toEqual([dup, pick].sort());
  });

  it("drops the group badge once only one member is still visible", async () => {
    const album = await service.createAlbumLogic(owner.id, { name: "Dupes" });
    const pick = await makePhoto(owner.id, "keep.jpg");
    const dup = await makePhoto(owner.id, "dup.jpg");
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: pick });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: dup });

    const group = await dbInsertReturning<{ id: number }>(
      db
        .insert(photoGroups)
        .values({ user_id: owner.id, cover_photo_id: pick })
        .returning({ id: photoGroups.id }),
    );
    await db.insert(photoGroupMembers).values([
      { group_id: group!.id, photo_id: pick, similarity_rank: 0 },
      { group_id: group!.id, photo_id: dup, similarity_rank: 1 },
    ]);

    // Both members visible → the cover carries a badge counting 2 members.
    const before = await listGalleryGridLogic(owner.id, { albumScopeId: album.id }, opts);
    expect(before.photos.find((p) => p.id === pick)?.group?.member_count).toBe(2);

    // Hide one member: only one visible member remains, so there is nothing
    // left to compare — no cell of the group gets a badge anymore.
    await db.insert(photoCuration).values({ user_id: owner.id, photo_id: dup, status: "hidden" });
    const after = await listGalleryGridLogic(owner.id, { albumScopeId: album.id }, opts);
    expect(after.photos.find((p) => p.id === pick)?.group).toBeUndefined();
    expect(after.photos.find((p) => p.id === dup)?.group).toBeUndefined();
  });
});
