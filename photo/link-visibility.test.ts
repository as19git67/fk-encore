// Per-photo opt-out of public link sharing.
//
// A photo flagged `link_hidden` must vanish from every anonymous view of the
// albums it sits in — the listing, the cover, and the raw file endpoint —
// while staying fully visible to signed-in users. These tests pin all three
// exits plus the "hide everyone I know" bulk pass.

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
  autoHideKnownFacesLogic,
  setPhotoLinkVisibilityLogic,
  LinkVisibilityAccessError,
} from "./link-visibility.service";
import { denyPhotoFileRequest } from "./photo-file-access";

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

describe("public link visibility", () => {
  let owner: any;
  let stranger: any;
  let album: any;
  let visible: any;
  let secret: any;
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

    visible = await service.uploadPhotoLogic(owner.id, {
      data: Buffer.from([1]),
      name: "beach.jpg",
      mimeType: "image/jpeg",
    });
    secret = await service.uploadPhotoLogic(owner.id, {
      data: Buffer.from([2]),
      name: "family.jpg",
      mimeType: "image/jpeg",
    });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: visible.id });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: secret.id });

    const link = await service.createAlbumPublicLinkLogic(owner.id, album.id);
    token = link.token;

    vi.mocked(getAuthData).mockReturnValue(undefined as never);
  });

  it("keeps a flagged photo out of the public listing but not out of the album", async () => {
    const before = await service.getPublicAlbumLogic(token);
    expect(before.photos.map(p => p.id).sort()).toEqual([visible.id, secret.id].sort());

    await setPhotoLinkVisibilityLogic(owner.id, [secret.id], true);

    const after = await service.getPublicAlbumLogic(token);
    expect(after.photos.map(p => p.id)).toEqual([visible.id]);
    expect(after.photo_count).toBe(1);

    const forOwner = await service.getAlbumLogic(owner.id, album.id, { includePhotos: true });
    expect(forOwner.photos.map(p => p.id).sort()).toEqual([visible.id, secret.id].sort());
    expect(forOwner.photos.find(p => p.id === secret.id)?.link_hidden).toBe(true);
    expect(forOwner.photos.find(p => p.id === visible.id)?.link_hidden).toBe(false);
  });

  it("refuses the raw file to a link visitor once the photo is flagged", async () => {
    expect(await denyPhotoFileRequest(secret.filename, token)).toBeNull();

    await setPhotoLinkVisibilityLogic(owner.id, [secret.id], true);

    expect(await denyPhotoFileRequest(secret.filename, token)).toEqual({ status: 403, body: "Forbidden" });
    expect(await denyPhotoFileRequest(visible.filename, token)).toBeNull();
  });

  it("restores the photo when the flag is cleared again", async () => {
    await setPhotoLinkVisibilityLogic(owner.id, [secret.id], true);
    const cleared = await setPhotoLinkVisibilityLogic(owner.id, [secret.id], false);
    expect(cleared.updated).toBe(1);

    const after = await service.getPublicAlbumLogic(token);
    expect(after.photos.map(p => p.id).sort()).toEqual([visible.id, secret.id].sort());
  });

  it("counts only photos whose flag actually changed", async () => {
    const first = await setPhotoLinkVisibilityLogic(owner.id, [visible.id, secret.id], true);
    expect(first.updated).toBe(2);
    const again = await setPhotoLinkVisibilityLogic(owner.id, [visible.id, secret.id], true);
    expect(again.updated).toBe(0);
  });

  it("does not serve a flagged cover to the public link", async () => {
    await service.updateAlbumLogic(owner.id, { id: album.id, coverPhotoId: secret.id });
    expect((await service.getPublicAlbumLogic(token)).cover_filename).toBe(secret.filename);

    await setPhotoLinkVisibilityLogic(owner.id, [secret.id], true);

    const after = await service.getPublicAlbumLogic(token);
    expect(after.cover_filename).toBe(visible.filename);
    expect(await denyPhotoFileRequest(secret.filename, token)).toEqual({ status: 403, body: "Forbidden" });
  });

  it("rejects a user with no access to the photo", async () => {
    await expect(setPhotoLinkVisibilityLogic(stranger.id, [secret.id], true))
      .rejects.toBeInstanceOf(LinkVisibilityAccessError);

    const row = await db.select().from(photos).where(eq(photos.id, secret.id));
    expect(row[0].link_hidden).toBe(false);
  });

  describe("known-faces bulk pass", () => {
    it("flags photos with a named person and leaves the rest alone", async () => {
      await addFace(secret.id, owner.id, "Alex Beispiel");
      await addFace(visible.id, owner.id, "Unbenannt");

      const res = await autoHideKnownFacesLogic(owner.id, { albumId: album.id });
      expect(res.updated).toBe(1);
      expect(res.alreadyHidden).toBe(0);

      const after = await service.getPublicAlbumLogic(token);
      expect(after.photos.map(p => p.id)).toEqual([visible.id]);
    });

    it("ignores faces the user rejected", async () => {
      await addFace(secret.id, owner.id, "Alex Beispiel", true);

      const res = await autoHideKnownFacesLogic(owner.id, { albumId: album.id });
      expect(res.updated).toBe(0);
      expect((await service.getPublicAlbumLogic(token)).photos).toHaveLength(2);
    });

    it("reports photos that were already flagged", async () => {
      await addFace(secret.id, owner.id, "Alex Beispiel");
      await setPhotoLinkVisibilityLogic(owner.id, [secret.id], true);

      const res = await autoHideKnownFacesLogic(owner.id, { albumId: album.id });
      expect(res).toMatchObject({ updated: 0, alreadyHidden: 1 });
    });

    it("can be limited to specific persons", async () => {
      const alex = await addFace(secret.id, owner.id, "Alex Beispiel");
      await addFace(visible.id, owner.id, "Kim Beispiel");

      const res = await autoHideKnownFacesLogic(owner.id, { personIds: [alex.personId] });
      expect(res.updated).toBe(1);
      expect((await service.getPublicAlbumLogic(token)).photos.map(p => p.id)).toEqual([visible.id]);
    });

    it("covers the whole library when no album is given", async () => {
      await addFace(secret.id, owner.id, "Alex Beispiel");
      await addFace(visible.id, owner.id, "Kim Beispiel");

      const res = await autoHideKnownFacesLogic(owner.id, {});
      expect(res.updated).toBe(2);
      expect((await service.getPublicAlbumLogic(token)).photos).toHaveLength(0);
    });

    it("refuses an album the caller cannot write", async () => {
      await addFace(secret.id, owner.id, "Alex Beispiel");
      await expect(autoHideKnownFacesLogic(stranger.id, { albumId: album.id })).rejects.toThrow();
    });
  });
});
