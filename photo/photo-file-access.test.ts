// Authorization for /photos/file/*.
//
// This was the last photo endpoint that served anybody who could name a
// file. Filenames are `YYYY/YYYY-MM/<upload timestamp>.<ext>` — narrow
// enough to walk — and the public-album listing hands real ones out. These
// tests pin both halves of the replacement: a signed-in photo viewer gets
// in, and a share-link visitor gets exactly the album that link exposes.

import crypto from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";

import db from "../db/database";
import {
  photos,
  albums,
  albumPhotos,
  albumShares,
  albumPublicLinks,
  albumUserSettings,
  photoCuration,
  users,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";
import { denyPhotoFileRequest } from "./photo-file-access";
import { getPhotoFile } from "./photo";

const VIEWER_PERMISSIONS = ["module.photos", "photos.view"];

/** Nobody is signed in unless a test says otherwise. */
function anonymous() {
  vi.mocked(getAuthData).mockReturnValue(undefined as never);
}

function signedInWith(permissions: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions });
}

describe("photo file access", () => {
  let owner: any;
  let album: any;
  let shared: any;
  let outside: any;
  let token: string;

  beforeEach(async () => {
    await db.delete(albumPublicLinks);
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(albumUserSettings);
    await db.delete(photoCuration);
    await db.delete(albums);
    await db.delete(photos);
    await db.delete(users);

    owner = await createUserLogic({ email: "owner@test.local", name: "O", password: "pw" });
    album = await service.createAlbumLogic(owner.id, { name: "Shared" });

    shared = await service.uploadPhotoLogic(owner.id, {
      data: Buffer.from([1]),
      name: "in-album.jpg",
      mimeType: "image/jpeg",
    });
    outside = await service.uploadPhotoLogic(owner.id, {
      data: Buffer.from([2]),
      name: "private.jpg",
      mimeType: "image/jpeg",
    });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: shared.id });

    const link = await service.createAlbumPublicLinkLogic(owner.id, album.id);
    token = link.token;

    anonymous();
  });

  describe("signed-in callers", () => {
    it("lets a photo viewer read any file, with no share token", async () => {
      signedInWith(VIEWER_PERMISSIONS);
      expect(await denyPhotoFileRequest(outside.filename, null)).toBeNull();
    });

    it("refuses a caller without photos.view", async () => {
      signedInWith(["module.photos"]);
      expect(await denyPhotoFileRequest(shared.filename, null)).toEqual({
        status: 403,
        body: "Forbidden",
      });
    });

    it("refuses a caller without the photos module", async () => {
      signedInWith(["photos.view"]);
      expect(await denyPhotoFileRequest(shared.filename, null)).toEqual({
        status: 403,
        body: "Forbidden",
      });
    });

    it("lets an account with no photo rights use a share link sent to them", async () => {
      // Having an account says nothing about this album. A finance-only user
      // who is sent a link must not be worse off than a stranger with the
      // same link.
      signedInWith(["module.finance"]);
      expect(await denyPhotoFileRequest(shared.filename, token)).toBeNull();
    });

    it("still refuses that account the rest of the library", async () => {
      signedInWith(["module.finance"]);
      expect(await denyPhotoFileRequest(outside.filename, token)).toEqual({
        status: 403,
        body: "Forbidden",
      });
    });
  });

  describe("anonymous callers", () => {
    it("refuses a request with no credential at all", async () => {
      expect(await denyPhotoFileRequest(shared.filename, null)).toEqual({
        status: 401,
        body: "Unauthorized",
      });
    });

    it("serves a photo the share link covers", async () => {
      expect(await denyPhotoFileRequest(shared.filename, token)).toBeNull();
    });

    it("refuses a photo outside the shared album", async () => {
      // The whole point: holding one share link must not turn into a key
      // for the rest of the library.
      expect(await denyPhotoFileRequest(outside.filename, token)).toEqual({
        status: 403,
        body: "Forbidden",
      });
    });

    it("refuses an unknown share token", async () => {
      expect(await denyPhotoFileRequest(shared.filename, "not-a-real-token")).toEqual({
        status: 403,
        body: "Forbidden",
      });
    });

    it("refuses a filename that does not exist", async () => {
      expect(await denyPhotoFileRequest("2020/2020-01/nope.jpg", token)).toEqual({
        status: 403,
        body: "Forbidden",
      });
    });
  });

  describe("link lifecycle", () => {
    it("stops serving once the link is revoked", async () => {
      await service.deleteAlbumPublicLinkLogic(owner.id, album.id);
      expect(await denyPhotoFileRequest(shared.filename, token)).toEqual({
        status: 403,
        body: "Forbidden",
      });
    });

    it("stops serving once the link has expired", async () => {
      await db
        .update(albumPublicLinks)
        .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(albumPublicLinks.token, token));

      expect(await denyPhotoFileRequest(shared.filename, token)).toEqual({
        status: 403,
        body: "Forbidden",
      });
    });
  });

  describe("hidden photos", () => {
    it("refuses a photo the owner has hidden, matching the public listing", async () => {
      // getPublicAlbumLogic drops photos any participant hid. If the file
      // endpoint did not, hiding a photo after sharing the link would do
      // nothing for anyone who had noted the URL.
      await db.insert(photoCuration).values({
        user_id: owner.id,
        photo_id: shared.id,
        status: "hidden",
      });

      expect(await denyPhotoFileRequest(shared.filename, token)).toEqual({
        status: 403,
        body: "Forbidden",
      });
    });

    it("refuses a photo a collaborator has hidden", async () => {
      const collaborator = await createUserLogic({
        email: "collab@test.local",
        name: "C",
        password: "pw",
      });
      await db.insert(albumShares).values({
        album_id: album.id,
        user_id: collaborator.id,
        access_level: "read",
      });
      await db.insert(photoCuration).values({
        user_id: collaborator.id,
        photo_id: shared.id,
        status: "hidden",
      });

      expect(await denyPhotoFileRequest(shared.filename, token)).toEqual({
        status: 403,
        body: "Forbidden",
      });
    });

    it("still serves a photo an unrelated user has hidden", async () => {
      const stranger = await createUserLogic({
        email: "stranger@test.local",
        name: "S",
        password: "pw",
      });
      await db.insert(photoCuration).values({
        user_id: stranger.id,
        photo_id: shared.id,
        status: "hidden",
      });

      expect(await denyPhotoFileRequest(shared.filename, token)).toBeNull();
    });
  });

  describe("the endpoint itself", () => {
    // The module above decides; these pin that getPhotoFile actually asks
    // it, and answers with the status it returns instead of the bytes.
    function fakeRes() {
      return {
        statusCode: 200,
        headers: {} as Record<string, string>,
        body: undefined as string | undefined,
        setHeader(name: string, value: string) {
          this.headers[name] = value;
        },
        end(body?: string) {
          this.body = body;
        },
      };
    }

    function fakeReq(url: string) {
      return { url, headers: { host: "example.test" } };
    }

    it("answers 401 for an anonymous request without a share token", async () => {
      const res = fakeRes();
      await (getPhotoFile as any)(fakeReq(`/photos/file/${shared.filename}`), res);
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe("Unauthorized");
    });

    it("answers 403 when the share token does not cover the file", async () => {
      const res = fakeRes();
      await (getPhotoFile as any)(
        fakeReq(`/photos/file/${outside.filename}?share=${token}`),
        res,
      );
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe("Forbidden");
    });

    it("does not let a shared cache keep what it just authorized", async () => {
      // The credential rides in the query string, so `public` would let a
      // proxy hand one visitor's copy to the next caller. Asserted on the
      // conditional-GET branch, which is the one success path that answers
      // with headers alone rather than streaming the file.
      signedInWith(VIEWER_PERMISSIONS);
      const etag = `"${crypto
        .createHash("md5")
        .update(`${shared.filename}|w=|c=0`)
        .digest("hex")}"`;
      const res = fakeRes();
      const req = {
        url: `/photos/file/${shared.filename}`,
        headers: { host: "example.test", "if-none-match": etag },
      };

      await (getPhotoFile as any)(req, res);

      expect(res.statusCode).toBe(304);
      expect(res.headers["Cache-Control"]).toBe("private, max-age=31536000, immutable");
    });
  });

  describe("album cover", () => {
    it("serves the cover for link previews even when it is not an album member", async () => {
      // Open Graph crawlers fetch cover_filename, which getPublicAlbumLogic
      // reports from albums.cover_photo_id without checking membership.
      await db
        .update(albums)
        .set({ cover_photo_id: outside.id })
        .where(eq(albums.id, album.id));

      expect(await denyPhotoFileRequest(outside.filename, token)).toBeNull();
    });
  });
});
