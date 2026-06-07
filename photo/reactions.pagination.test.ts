import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import {
  photos,
  albums,
  albumPhotos,
  albumShares,
  photoComments,
  users,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as photo from "./photo.service";
import { createComment, listCommentsPage } from "./reactions.service";

/**
 * Paginated, newest-first comment listing used by the feed card's comment
 * section: a page size cap and an id cursor for loading older comments.
 */
describe("reactions: listCommentsPage", () => {
  let owner: any;

  beforeEach(async () => {
    await db.delete(photoComments);
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(albums);
    await db.delete(photos);
    await db.delete(users);
    owner = await createUserLogic({ email: "owner@test.com", name: "Owner", password: "pw" });
  });

  async function seedPhotoInAlbum() {
    const album = await photo.createAlbumLogic(owner.id, { name: "A" });
    const p = await photo.uploadPhotoLogic(owner.id, {
      data: Buffer.from([1, 2, 3, 4]),
      name: "p.jpg",
      mimeType: "image/jpeg",
    });
    await photo.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: p.id });
    return { albumId: album.id, photoId: p.id };
  }

  it("returns comments newest-first and pages older ones via the cursor", async () => {
    const { albumId, photoId } = await seedPhotoInAlbum();
    // Five comments, in order. ids are monotonic, so c5 is newest.
    const created = [];
    for (let i = 1; i <= 5; i++) {
      created.push(await createComment(owner.id, photoId, `c${i}`, albumId));
    }

    // First page (size 2): newest first → c5, c4. More remain.
    const page1 = await listCommentsPage(owner.id, photoId, albumId, 2, null);
    expect(page1.comments.map((c) => c.body)).toEqual(["c5", "c4"]);
    expect(page1.nextCursor).toBe(created[3].id); // id of c4 (oldest loaded)

    // Second page: c3, c2.
    const page2 = await listCommentsPage(owner.id, photoId, albumId, 2, page1.nextCursor);
    expect(page2.comments.map((c) => c.body)).toEqual(["c3", "c2"]);
    expect(page2.nextCursor).toBe(created[1].id);

    // Final page: only c1 left → no further cursor.
    const page3 = await listCommentsPage(owner.id, photoId, albumId, 2, page2.nextCursor);
    expect(page3.comments.map((c) => c.body)).toEqual(["c1"]);
    expect(page3.nextCursor).toBeNull();
  });

  it("caps the page size at 100", async () => {
    const { albumId, photoId } = await seedPhotoInAlbum();
    await createComment(owner.id, photoId, "only", albumId);
    // Asking for more than the cap must not throw and returns what exists.
    const res = await listCommentsPage(owner.id, photoId, albumId, 1000, null);
    expect(res.comments.map((c) => c.body)).toEqual(["only"]);
    expect(res.nextCursor).toBeNull();
  });

  it("rejects a viewer without access to the album", async () => {
    const { albumId, photoId } = await seedPhotoInAlbum();
    const stranger = await createUserLogic({ email: "x@test.com", name: "X", password: "pw" });
    await expect(listCommentsPage(stranger.id, photoId, albumId, 50, null)).rejects.toThrow();
  });
});
