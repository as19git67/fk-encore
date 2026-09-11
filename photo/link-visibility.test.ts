// What an anonymous public-link visitor gets to see, photo by photo.
//
// The default is privacy-first: a photo with a face assigned to a named
// person stays off the link until it is explicitly released. These tests pin
// that rule at all three exits a link visitor has — the listing, the album
// cover (which feeds the Open Graph preview) and the raw file endpoint —
// plus the explicit per-photo overrides in both directions.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";

import db from "../db/database";
import {
  albumPhotos,
  albumPublicLinks,
  albumShares,
  albumUserSettings,
  albums,
  faces,
  persons,
  photoCuration,
  photos,
  userFaceAssignments,
  users,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";
import {
  setKnownFaceLinkVisibilityLogic,
  setPhotoLinkVisibilityLogic,
  LinkVisibilityAccessError,
} from "./link-visibility.service";
import { denyPhotoFileRequest } from "./photo-file-access";
import type { GalleryGridEntry } from "../db/types";
import { listGalleryGridLogic } from "./gallery-grid.service";

async function addFace(photoId: number, userId: number, personName: string, ignored = false) {
  const [face] = await db
    .insert(faces)
    .values({
      photo_id: photoId,
      bbox: JSON.stringify({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }),
      embedding: JSON.stringify([]),
    })
    .returning({ id: faces.id });
  const [person] = await db
    .insert(persons)
    .values({ user_id: userId, name: personName })
    .returning({ id: persons.id });
  await db.insert(userFaceAssignments).values({
    user_id: userId,
    face_id: face.id,
    person_id: person.id,
    ignored,
  });
  return { faceId: face.id, personId: person.id };
}

async function publicPhotoIds(token: string): Promise<number[]> {
  return (await service.getPublicAlbumLogic(token)).photos.map(p => p.id);
}

describe("public link visibility", () => {
  let owner: any;
  let stranger: any;
  let album: any;
  let scenery: any;
  let portrait: any;
  let token: string;

  beforeEach(async () => {
    await db.delete(userFaceAssignments);
    await db.delete(faces);
    await db.delete(persons);
    await db.delete(albumPublicLinks);
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(albumUserSettings);
    await db.delete(photoCuration);
    await db.delete(albums);
    await db.delete(photos);
    await db.delete(users);

    owner = await createUserLogic({ email: "owner@test.local", name: "O", password: "pw" });
    stranger = await createUserLogic({ email: "stranger@test.local", name: "S", password: "pw" });
    album = await service.createAlbumLogic(owner.id, { name: "Urlaub" });

    scenery = await service.uploadPhotoLogic(owner.id, {
      data: Buffer.from([1]),
      name: "beach.jpg",
      mimeType: "image/jpeg",
    });
    portrait = await service.uploadPhotoLogic(owner.id, {
      data: Buffer.from([2]),
      name: "family.jpg",
      mimeType: "image/jpeg",
    });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: scenery.id });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: portrait.id });

    const link = await service.createAlbumPublicLinkLogic(owner.id, album.id);
    token = link.token;

    vi.mocked(getAuthData).mockReturnValue(undefined as never);
  });

  describe("the default", () => {
    it("withholds a photo with a known face and keeps the rest", async () => {
      expect((await publicPhotoIds(token)).sort()).toEqual([scenery.id, portrait.id].sort());

      await addFace(portrait.id, owner.id, "Alex Beispiel");

      const after = await service.getPublicAlbumLogic(token);
      expect(after.photos.map(p => p.id)).toEqual([scenery.id]);
      expect(after.photo_count).toBe(1);
    });

    it("leaves the album itself untouched for signed-in users", async () => {
      await addFace(portrait.id, owner.id, "Alex Beispiel");

      const forOwner = await service.getAlbumLogic(owner.id, album.id, { includePhotos: true });
      expect(forOwner.photos.map(p => p.id).sort()).toEqual([scenery.id, portrait.id].sort());
      const hit = forOwner.photos.find(p => p.id === portrait.id)!;
      expect(hit.link_visibility).toBe("auto");
      expect(hit.has_known_face).toBe(true);
      expect(forOwner.photos.find(p => p.id === scenery.id)?.has_known_face).toBe(false);
    });

    it("refuses the raw file for a photo the listing withholds", async () => {
      expect(await denyPhotoFileRequest(portrait.filename, token)).toBeNull();

      await addFace(portrait.id, owner.id, "Alex Beispiel");

      expect(await denyPhotoFileRequest(portrait.filename, token)).toEqual({ status: 403, body: "Forbidden" });
      expect(await denyPhotoFileRequest(scenery.filename, token)).toBeNull();
    });

    it("does not count an unnamed person as a known face", async () => {
      await addFace(portrait.id, owner.id, "Unbenannt");
      expect((await publicPhotoIds(token)).sort()).toEqual([scenery.id, portrait.id].sort());
    });

    it("does not count a face the user rejected", async () => {
      await addFace(portrait.id, owner.id, "Alex Beispiel", true);
      expect((await publicPhotoIds(token)).sort()).toEqual([scenery.id, portrait.id].sort());
    });

    it("counts a face named by a collaborator, not just by the owner", async () => {
      await service.shareAlbumLogic(owner.id, { albumId: album.id, userId: stranger.id, accessLevel: "read" });
      await addFace(portrait.id, stranger.id, "Alex Beispiel");

      expect(await publicPhotoIds(token)).toEqual([scenery.id]);
    });
  });

  describe("explicit overrides", () => {
    it("releases a photo with a known face when set to visible", async () => {
      await addFace(portrait.id, owner.id, "Alex Beispiel");
      expect(await publicPhotoIds(token)).toEqual([scenery.id]);

      const res = await setPhotoLinkVisibilityLogic(owner.id, [portrait.id], "visible");
      expect(res.updated).toBe(1);

      expect((await publicPhotoIds(token)).sort()).toEqual([scenery.id, portrait.id].sort());
      expect(await denyPhotoFileRequest(portrait.filename, token)).toBeNull();
    });

    it("withholds a photo without any face when set to hidden", async () => {
      await setPhotoLinkVisibilityLogic(owner.id, [scenery.id], "hidden");

      expect(await publicPhotoIds(token)).toEqual([portrait.id]);
      expect(await denyPhotoFileRequest(scenery.filename, token)).toEqual({ status: 403, body: "Forbidden" });
    });

    it("returns to the default when set back to auto", async () => {
      await addFace(portrait.id, owner.id, "Alex Beispiel");
      await setPhotoLinkVisibilityLogic(owner.id, [portrait.id], "visible");
      await setPhotoLinkVisibilityLogic(owner.id, [portrait.id], "auto");

      expect(await publicPhotoIds(token)).toEqual([scenery.id]);
    });

    it("counts only photos whose setting actually changed", async () => {
      const first = await setPhotoLinkVisibilityLogic(owner.id, [scenery.id, portrait.id], "hidden");
      expect(first.updated).toBe(2);
      const again = await setPhotoLinkVisibilityLogic(owner.id, [scenery.id, portrait.id], "hidden");
      expect(again.updated).toBe(0);
    });

    it("rejects a user with no access to the photo", async () => {
      await expect(setPhotoLinkVisibilityLogic(stranger.id, [portrait.id], "hidden"))
        .rejects.toBeInstanceOf(LinkVisibilityAccessError);

      const row = await db.select().from(photos).where(eq(photos.id, portrait.id));
      expect(row[0].link_visibility).toBe("auto");
    });
  });

  describe("album cover", () => {
    it("is not served to the link when the cover itself is withheld", async () => {
      await service.updateAlbumLogic(owner.id, { id: album.id, coverPhotoId: portrait.id });
      expect((await service.getPublicAlbumLogic(token)).cover_filename).toBe(portrait.filename);

      await addFace(portrait.id, owner.id, "Alex Beispiel");

      const after = await service.getPublicAlbumLogic(token);
      expect(after.cover_filename).toBe(scenery.filename);
      expect(await denyPhotoFileRequest(portrait.filename, token)).toEqual({ status: 403, body: "Forbidden" });
    });
  });

  describe("known-faces bulk pass", () => {
    it("releases every photo with a known face in an album", async () => {
      await addFace(portrait.id, owner.id, "Alex Beispiel");

      const res = await setKnownFaceLinkVisibilityLogic(owner.id, { visibility: "visible", albumId: album.id });
      expect(res).toMatchObject({ updated: 1, unchanged: 0 });
      expect((await publicPhotoIds(token)).sort()).toEqual([scenery.id, portrait.id].sort());
    });

    it("reports photos that already carried the setting", async () => {
      await addFace(portrait.id, owner.id, "Alex Beispiel");
      await setPhotoLinkVisibilityLogic(owner.id, [portrait.id], "visible");

      const res = await setKnownFaceLinkVisibilityLogic(owner.id, { visibility: "visible", albumId: album.id });
      expect(res).toMatchObject({ updated: 0, unchanged: 1 });
    });

    it("can be limited to specific persons", async () => {
      const alex = await addFace(portrait.id, owner.id, "Alex Beispiel");
      await addFace(scenery.id, owner.id, "Kim Beispiel");
      expect(await publicPhotoIds(token)).toEqual([]);

      const res = await setKnownFaceLinkVisibilityLogic(owner.id, {
        visibility: "visible",
        personIds: [alex.personId],
      });
      expect(res.updated).toBe(1);
      expect(await publicPhotoIds(token)).toEqual([portrait.id]);
    });

    it("covers the whole library when no album is given", async () => {
      await addFace(portrait.id, owner.id, "Alex Beispiel");
      await addFace(scenery.id, owner.id, "Kim Beispiel");

      const res = await setKnownFaceLinkVisibilityLogic(owner.id, { visibility: "visible" });
      expect(res.updated).toBe(2);
      expect((await publicPhotoIds(token)).sort()).toEqual([scenery.id, portrait.id].sort());
    });

    it("refuses an album the caller cannot write", async () => {
      await addFace(portrait.id, owner.id, "Alex Beispiel");
      await expect(
        setKnownFaceLinkVisibilityLogic(stranger.id, { visibility: "visible", albumId: album.id }),
      ).rejects.toThrow();
    });
  });

  describe("album grid marker", () => {
    async function gridEntries(): Promise<GalleryGridEntry[]> {
      const res = await listGalleryGridLogic(
        owner.id,
        { albumScopeId: album.id },
        { limit: 50, sortBy: "taken_at", sortDir: "asc" },
      );
      return res.photos;
    }

    it("marks the photos the link does not show", async () => {
      await addFace(portrait.id, owner.id, "Alex Beispiel");

      const entries = await gridEntries();
      expect(entries.find(e => e.id === portrait.id)?.link_hidden).toBe(true);
      expect(entries.find(e => e.id === scenery.id)?.link_hidden).toBeUndefined();
    });

    it("stays silent once the photo is released", async () => {
      await addFace(portrait.id, owner.id, "Alex Beispiel");
      await setPhotoLinkVisibilityLogic(owner.id, [portrait.id], "visible");

      const entries = await gridEntries();
      expect(entries.every(e => e.link_hidden === undefined)).toBe(true);
    });

    it("stays silent while the album has no public link at all", async () => {
      await service.deleteAlbumPublicLinkLogic(owner.id, album.id);
      await addFace(portrait.id, owner.id, "Alex Beispiel");

      const entries = await gridEntries();
      expect(entries.every(e => e.link_hidden === undefined)).toBe(true);
    });
  });
});
