// Per-photo and per-person scope on the endpoints issue #1435 listed beyond
// the file endpoints: a viewer with the photos module must not learn
// anything about another account's private photos or people by id.

import { describe, it, expect, beforeEach } from "vitest";
import { APIError } from "encore.dev/api";
import { eq } from "drizzle-orm";
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
  photos,
  userFaceAssignments,
  users,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";
import { assertPhotoAccess, publicLinkCoversPhoto } from "./photo-file-access";
import { assertPhotoInPublicLink } from "./reactions.service";

function notFound(e: unknown): boolean {
  return e instanceof APIError && e.code === "not_found";
}

describe("photo scope (#1435)", () => {
  let owner: any;
  let member: any;
  let stranger: any;
  let album: any;
  let shared: any;
  let privatePhoto: any;

  beforeEach(async () => {
    await db.delete(photoComments);
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

    owner = await createUserLogic({ email: "owner@test.local", name: "O", password: "pw" });
    member = await createUserLogic({ email: "member@test.local", name: "M", password: "pw" });
    stranger = await createUserLogic({ email: "stranger@test.local", name: "S", password: "pw" });

    album = await service.createAlbumLogic(owner.id, { name: "Shared" });
    shared = await service.uploadPhotoLogic(owner.id, {
      data: Buffer.from([1]),
      name: "in-album.jpg",
      mimeType: "image/jpeg",
    });
    privatePhoto = await service.uploadPhotoLogic(owner.id, {
      data: Buffer.from([2]),
      name: "private.jpg",
      mimeType: "image/jpeg",
    });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: shared.id });
    await service.shareAlbumLogic(owner.id, {
      albumId: album.id,
      userId: member.id,
      accessLevel: "read",
    });
  });

  describe("assertPhotoAccess", () => {
    it("passes the owner, a shared-album member and the album cover", async () => {
      await assertPhotoAccess(owner.id, privatePhoto.id);
      await assertPhotoAccess(member.id, shared.id);
      await db.update(albums).set({ cover_photo_id: privatePhoto.id }).where(eq(albums.id, album.id));
      await assertPhotoAccess(member.id, privatePhoto.id);
    });

    it("answers a stranger and a non-member like a missing photo", async () => {
      await expect(assertPhotoAccess(stranger.id, shared.id)).rejects.toSatisfy(notFound);
      await expect(assertPhotoAccess(member.id, privatePhoto.id)).rejects.toSatisfy(notFound);
      await expect(assertPhotoAccess(owner.id, 999_999)).rejects.toSatisfy(notFound);
    });
  });

  describe("people", () => {
    async function personOf(userId: number, name: string): Promise<number> {
      const row = await dbInsertReturning<{ id: number }>(
        db.insert(persons).values({ user_id: userId, name }).returning({ id: persons.id }),
      );
      return row!.id;
    }

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

    it("renaming returns only the caller's own person", async () => {
      const theirs = await personOf(owner.id, "Alice");
      // The stranger's UPDATE matches nothing; the re-read must not echo
      // the owner's record (name, cover filename) back to them.
      await expect(service.updatePersonLogic(stranger.id, theirs, "Mallory")).rejects.toSatisfy(notFound);
      const unchanged = await db.select().from(persons).where(eq(persons.id, theirs));
      expect(unchanged[0]!.name).toBe("Alice");

      const mine = await personOf(owner.id, "Bob");
      const updated = await service.updatePersonLogic(owner.id, mine, "Robert");
      expect(updated.name).toBe("Robert");
    });

    it("renaming an unknown person is a 404, not a crash", async () => {
      await expect(service.updatePersonLogic(owner.id, 999_999, "X")).rejects.toSatisfy(notFound);
    });

    it("a face can only be assigned to one of the caller's own persons", async () => {
      const faceId = await faceOn(shared.id);
      await db.insert(userFaceAssignments).values({
        user_id: member.id, face_id: faceId, person_id: null, ignored: false,
      });
      const ownersPerson = await personOf(owner.id, "Alice");

      await expect(
        service.assignFaceToPersonLogic(member.id, faceId, ownersPerson),
      ).rejects.toSatisfy(notFound);
      const rows = await db.select().from(userFaceAssignments).where(eq(userFaceAssignments.face_id, faceId));
      expect(rows[0]!.person_id).toBeNull();

      const membersPerson = await personOf(member.id, "Carol");
      await service.assignFaceToPersonLogic(member.id, faceId, membersPerson);
      const after = await db.select().from(userFaceAssignments).where(eq(userFaceAssignments.face_id, faceId));
      expect(after[0]!.person_id).toBe(membersPerson);
    });
  });

  describe("uploaders", () => {
    it("lists only users whose photos the caller can see", async () => {
      const theirOwn = await service.uploadPhotoLogic(stranger.id, {
        data: Buffer.from([3]),
        name: "mine.jpg",
        mimeType: "image/jpeg",
      });
      expect(theirOwn.user_id).toBe(stranger.id);

      // The member sees the owner's photo through the album, but has no
      // photo of their own and nothing from the stranger.
      const forMember = await service.listPhotoUploadersLogic(member.id);
      expect(forMember.uploaders.map((u) => u.id)).toEqual([owner.id]);

      // The stranger only sees themselves.
      const forStranger = await service.listPhotoUploadersLogic(stranger.id);
      expect(forStranger.uploaders.map((u) => u.id)).toEqual([stranger.id]);
    });
  });

  describe("guest comments follow the public listing", () => {
    let linkId: number;

    beforeEach(async () => {
      const link = await service.createAlbumPublicLinkLogic(owner.id, album.id);
      const row = await db.select({ id: albumPublicLinks.id }).from(albumPublicLinks).where(eq(albumPublicLinks.token, link.token));
      linkId = row[0]!.id;
    });

    it("reaches a photo the link shows", async () => {
      expect(await publicLinkCoversPhoto(linkId, shared.id)).toBe(true);
      expect(await assertPhotoInPublicLink(shared.id, linkId)).toBe(album.id);
    });

    it("does not reach a photo outside the album", async () => {
      expect(await publicLinkCoversPhoto(linkId, privatePhoto.id)).toBe(false);
      await expect(assertPhotoInPublicLink(privatePhoto.id, linkId)).rejects.toSatisfy(notFound);
    });

    it("does not reach a photo the owner hid or opted out of the link", async () => {
      await db.insert(photoCuration).values({ user_id: owner.id, photo_id: shared.id, status: "hidden" });
      await expect(assertPhotoInPublicLink(shared.id, linkId)).rejects.toSatisfy(notFound);
      await db.delete(photoCuration);

      await db.update(photos).set({ link_visibility: "hidden" }).where(eq(photos.id, shared.id));
      await expect(assertPhotoInPublicLink(shared.id, linkId)).rejects.toSatisfy(notFound);
    });
  });
});
