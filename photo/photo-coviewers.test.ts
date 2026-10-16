// What one person's dealings with a photo reveal to others stays within the
// people who see the photo the way they do (photo release plan, stage 0).
//
// Setup: the owner's photo sits in the owner's album, shared with a member,
// and — reused — in another user's private album, shared with a guest of
// theirs. The two groups see the same photo but must learn nothing about
// each other: not their edits, not their favourites, not their comments,
// not the names they give faces.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { APIError } from "encore.dev/api";
import { and, eq } from "drizzle-orm";
import { realtime } from "~encore/clients";
import db from "../db/database";
import { dbInsertReturning } from "../db/adapter";
import {
  albumPhotos,
  albumPublicLinks,
  albumShares,
  albums,
  faces,
  persons,
  photoComments,
  photoCuration,
  photoTransforms,
  photos,
  userFaceAssignments,
  users,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";
import { coViewerIds } from "./photo-file-access";
import { adoptTransformLogic, getPhotoTransformsLogic, upsertOwnTransformLogic } from "./photo-transforms-crud.service";
import { createComment, deleteComment, listComments } from "./reactions.service";

function notFound(e: unknown): boolean {
  return e instanceof APIError && e.code === "not_found";
}

describe("co-viewers of a photo (photo release stage 0)", () => {
  let owner: any;
  let member: any;
  let other: any;
  let guest: any;
  let stranger: any;
  let ownersAlbum: any;
  let othersAlbum: any;
  let photo: any;

  beforeEach(async () => {
    await db.delete(photoComments);
    await db.delete(photoTransforms);
    await db.delete(userFaceAssignments);
    await db.delete(faces);
    await db.delete(persons);
    await db.delete(albumPublicLinks);
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(photoCuration);
    await db.delete(albums);
    await db.delete(photos);
    await db.delete(users);
    vi.mocked(realtime.publishEvent).mockClear();

    owner = await createUserLogic({ email: "owner@test.local", name: "O", password: "pw" });
    member = await createUserLogic({ email: "member@test.local", name: "M", password: "pw" });
    other = await createUserLogic({ email: "other@test.local", name: "X", password: "pw" });
    guest = await createUserLogic({ email: "guest@test.local", name: "G", password: "pw" });
    stranger = await createUserLogic({ email: "stranger@test.local", name: "S", password: "pw" });

    photo = await service.uploadPhotoLogic(owner.id, { data: Buffer.from([1]), name: "p.jpg", mimeType: "image/jpeg" });
    ownersAlbum = await service.createAlbumLogic(owner.id, { name: "Familie" });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: ownersAlbum.id, photoId: photo.id });
    await service.shareAlbumLogic(owner.id, { albumId: ownersAlbum.id, userId: member.id, accessLevel: "read" });

    // Another user's private album that reused the photo, shared with their guest.
    othersAlbum = await service.createAlbumLogic(other.id, { name: "Privat" });
    await db.insert(albumPhotos).values({ album_id: othersAlbum.id, photo_id: photo.id, added_by_user_id: other.id });
    await service.shareAlbumLogic(other.id, { albumId: othersAlbum.id, userId: guest.id, accessLevel: "read" });
  });

  it("are the viewer and the people of the albums they see it through", async () => {
    expect((await coViewerIds(member.id, photo.id)).sort()).toEqual([owner.id, member.id].sort());
    expect((await coViewerIds(owner.id, photo.id)).sort()).toEqual([owner.id, member.id].sort());
    // The owner is not part of somebody else's private album by owning the photo.
    expect((await coViewerIds(guest.id, photo.id)).sort()).toEqual([other.id, guest.id].sort());
    expect(await coViewerIds(stranger.id, photo.id)).toEqual([stranger.id]);
  });

  describe("edit recipes", () => {
    beforeEach(async () => {
      for (const u of [owner, member, other, guest]) {
        await upsertOwnTransformLogic(u.id, photo.id, { exposure: 0.1 });
      }
    });

    it("show only the co-viewers' recipes", async () => {
      const bundle = await getPhotoTransformsLogic(member.id, photo.id);
      expect(bundle.others.map((o) => o.user_id)).toEqual([owner.id]);
      const guests = await getPhotoTransformsLogic(guest.id, photo.id);
      expect(guests.others.map((o) => o.user_id)).toEqual([other.id]);
    });

    it("cannot adopt a recipe from the other group", async () => {
      const [row] = await db
        .select({ id: photoTransforms.id })
        .from(photoTransforms)
        .where(and(eq(photoTransforms.photo_id, photo.id), eq(photoTransforms.user_id, guest.id)));
      await expect(adoptTransformLogic(member.id, photo.id, row!.id)).rejects.toSatisfy(notFound);
      const [mine] = await db
        .select({ id: photoTransforms.id })
        .from(photoTransforms)
        .where(and(eq(photoTransforms.photo_id, photo.id), eq(photoTransforms.user_id, owner.id)));
      await expect(adoptTransformLogic(member.id, photo.id, mine!.id)).resolves.toMatchObject({ source: "adopted" });
    });
  });

  it("a favourite reaches only the co-viewers", async () => {
    await service.updatePhotoCurationLogic(guest.id, photo.id, "favorite");
    const call = vi
      .mocked(realtime.publishEvent)
      .mock.calls.map(([e]) => e)
      .find((e) => e.type === "curation.changed");
    expect(call?.userIds.map(Number).sort()).toEqual([other.id, guest.id].sort());
  });

  it("curation by a stranger reads as a missing photo", async () => {
    await expect(service.updatePhotoCurationLogic(stranger.id, photo.id, "hidden")).rejects.toSatisfy(notFound);
  });

  describe("comments", () => {
    it("in somebody else's album are not open to the photo's owner", async () => {
      const c = await createComment(guest.id, photo.id, "Schön", othersAlbum.id);
      await expect(listComments(owner.id, photo.id, othersAlbum.id)).rejects.toSatisfy(notFound);
      await expect(createComment(owner.id, photo.id, "Hallo", othersAlbum.id)).rejects.toSatisfy(notFound);
      await expect(deleteComment(owner.id, c.id)).rejects.toThrow();
      expect((await listComments(other.id, photo.id, othersAlbum.id)).map((x) => x.id)).toEqual([c.id]);
    });

    it("in the owner's own album stay theirs to moderate", async () => {
      const c = await createComment(member.id, photo.id, "Toll", ownersAlbum.id);
      await expect(deleteComment(owner.id, c.id)).resolves.toEqual({ success: true });
    });
  });

  describe("faces and people", () => {
    async function faceOn(photoId: number): Promise<number> {
      const row = await dbInsertReturning<{ id: number }>(
        db.insert(faces).values({
          photo_id: photoId,
          bbox: JSON.stringify({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }),
          embedding: "[]",
        }).returning({ id: faces.id }),
      );
      return row!.id;
    }

    async function personOf(userId: number, name: string): Promise<number> {
      const row = await dbInsertReturning<{ id: number }>(
        db.insert(persons).values({ user_id: userId, name }).returning({ id: persons.id }),
      );
      return row!.id;
    }

    it("a face on a photo out of sight cannot be assigned or ignored", async () => {
      const face = await faceOn(photo.id);
      const p = await personOf(stranger.id, "Jemand");
      await expect(service.assignFaceToPersonLogic(stranger.id, face, p)).rejects.toSatisfy(notFound);
      await expect(service.ignoreFaceLogic(stranger.id, face)).rejects.toSatisfy(notFound);
    });

    it("leave a member's people when the album they saw the photo in is deleted", async () => {
      const face = await faceOn(photo.id);
      const p = await personOf(member.id, "Musterperson");
      await db.insert(userFaceAssignments).values({ user_id: member.id, face_id: face, person_id: p, ignored: false });
      expect((await service.getPersonDetailsLogic(member.id, p)).faces).toHaveLength(1);

      await service.deleteAlbumLogic(owner.id, ownersAlbum.id);

      const left = await db.select().from(userFaceAssignments).where(eq(userFaceAssignments.user_id, member.id));
      expect(left).toEqual([]);
    });

    it("leave when the photo is taken out of the album", async () => {
      const face = await faceOn(photo.id);
      const p = await personOf(member.id, "Musterperson");
      await db.insert(userFaceAssignments).values({ user_id: member.id, face_id: face, person_id: p, ignored: false });

      await service.batchUpdateAlbumPhotosLogic(owner.id, { albumIds: [ownersAlbum.id], photoIds: [photo.id], action: "remove" });

      const left = await db.select().from(userFaceAssignments).where(eq(userFaceAssignments.user_id, member.id));
      expect(left).toEqual([]);
      // The owner keeps theirs: the photo is still their own.
    });

    it("a person page never shows a face from a photo out of sight", async () => {
      const face = await faceOn(photo.id);
      const p = await personOf(stranger.id, "Musterperson");
      // A stale row, as left behind before the cleanup existed.
      await db.insert(userFaceAssignments).values({ user_id: stranger.id, face_id: face, person_id: p, ignored: false });
      expect((await service.getPersonDetailsLogic(stranger.id, p)).faces).toEqual([]);
      const list = await service.listPersonsLogic(stranger.id);
      expect(list.persons.find((x) => x.id === p)?.cover_filename ?? "").toBe("");
    });
  });

  it("the places of a photo out of sight read as missing", async () => {
    await expect(service.getPhotoLocationsLogic(stranger.id, photo.id)).rejects.toSatisfy(notFound);
    await expect(service.getPhotoLocationsLogic(guest.id, photo.id)).resolves.toBeTruthy();
  });
});
