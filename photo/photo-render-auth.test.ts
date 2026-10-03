// Authorization tests for the raw photo-rendering endpoints.
//
// /photos/:id/render and /photos/:id/export are addressed by the photo's
// sequential id. While they were `auth: false`, anyone could walk id=1,2,3,…
// and pull the whole library, and `v=original` additionally answered with
// the photo's filename — the one thing /photos/file/* relies on not being
// guessable. These tests pin the gate that closed that, and the second gate
// behind it: a signed-in viewer only gets photos within their own scope
// (own uploads, albums they own or that are shared with them). Anything
// else is answered like a missing photo.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { photos, albums, albumPhotos, albumShares, users } from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";
import { renderPhotoTransformed, exportPhotoTransformed } from "./photo";

/** Minimal stand-in for the Node response object the raw handlers write to. */
function fakeRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(body?: string) {
      this.body = body;
      this.ended = true;
    },
  };
}

function fakeReq(url: string) {
  return { url, headers: { host: "example.test" } };
}

const RENDER_URL = "/photos/1/render?v=original";
const EXPORT_URL = "/photos/1/export?v=user&user=1";

const FULL_PERMISSIONS = ["module.photos", "photos.view"];

beforeEach(() => {
  vi.mocked(getAuthData).mockReturnValue({
    userID: "1",
    permissions: FULL_PERMISSIONS,
  });
});

describe("renderPhotoTransformed — authorization", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    vi.mocked(getAuthData).mockReturnValue(undefined as never);
    const res = fakeRes();

    await (renderPhotoTransformed as any)(fakeReq(RENDER_URL), res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("Unauthorized");
  });

  it("rejects a caller without photos.view with 403", async () => {
    vi.mocked(getAuthData).mockReturnValue({
      userID: "1",
      permissions: ["module.photos"],
    });
    const res = fakeRes();

    await (renderPhotoTransformed as any)(fakeReq(RENDER_URL), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Forbidden");
  });

  it("rejects a caller without the photos module with 403", async () => {
    vi.mocked(getAuthData).mockReturnValue({
      userID: "1",
      permissions: ["photos.view"],
    });
    const res = fakeRes();

    await (renderPhotoTransformed as any)(fakeReq(RENDER_URL), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Forbidden");
  });

  it("does not leak the filename to an unauthorized caller", async () => {
    // The v=original branch answers with a 302 to /photos/file/<filename>.
    // An unauthorized caller must not reach it — that redirect was the
    // oracle that turned a guessable id into a downloadable filename.
    vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: [] });
    const res = fakeRes();

    await (renderPhotoTransformed as any)(fakeReq(RENDER_URL), res);

    expect(res.statusCode).toBe(403);
    expect(res.headers["Location"]).toBeUndefined();
  });

  it("lets an authorized caller past the gate", async () => {
    const res = fakeRes();

    await (renderPhotoTransformed as any)(fakeReq(RENDER_URL), res);

    // Photo 1 does not exist in this test DB, so the handler proceeds to
    // the lookup and 404s. The point is that it got past authorization
    // rather than being turned away with 401/403.
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});

describe("exportPhotoTransformed — authorization", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    vi.mocked(getAuthData).mockReturnValue(undefined as never);
    const res = fakeRes();

    await (exportPhotoTransformed as any)(fakeReq(EXPORT_URL), res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("Unauthorized");
  });

  it("rejects a caller without photos.view with 403", async () => {
    vi.mocked(getAuthData).mockReturnValue({
      userID: "1",
      permissions: ["module.photos"],
    });
    const res = fakeRes();

    await (exportPhotoTransformed as any)(fakeReq(EXPORT_URL), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Forbidden");
  });

  it("lets an authorized caller past the gate", async () => {
    const res = fakeRes();

    await (exportPhotoTransformed as any)(fakeReq(EXPORT_URL), res);

    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});

describe("per-photo scope", () => {
  let owner: any;
  let other: any;
  let album: any;
  let inAlbum: any;
  let privatePhoto: any;

  beforeEach(async () => {
    await db.delete(albumPhotos);
    await db.delete(albumShares);
    await db.delete(albums);
    await db.delete(photos);
    await db.delete(users);

    owner = await createUserLogic({ email: "owner@test.local", name: "O", password: "pw" });
    other = await createUserLogic({ email: "other@test.local", name: "X", password: "pw" });
    album = await service.createAlbumLogic(owner.id, { name: "Shared" });
    inAlbum = await service.uploadPhotoLogic(owner.id, {
      data: Buffer.from([1]),
      name: "in-album.jpg",
      mimeType: "image/jpeg",
    });
    privatePhoto = await service.uploadPhotoLogic(owner.id, {
      data: Buffer.from([2]),
      name: "private.jpg",
      mimeType: "image/jpeg",
    });
    await service.addPhotoToAlbumLogic(owner.id, { albumId: album.id, photoId: inAlbum.id });
    await service.shareAlbumLogic(owner.id, {
      albumId: album.id,
      userId: other.id,
      accessLevel: "read",
    });
  });

  function signedInAs(userId: number) {
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(userId),
      permissions: FULL_PERMISSIONS,
    });
  }

  it("redirects the owner to their own file", async () => {
    signedInAs(owner.id);
    const res = fakeRes();

    await (renderPhotoTransformed as any)(
      fakeReq(`/photos/${privatePhoto.id}/render?v=original`),
      res,
    );

    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`/photos/file/${privatePhoto.filename}`);
  });

  it("answers another viewer like the photo did not exist", async () => {
    // A viewer who is not the owner and holds no share must neither get the
    // bytes nor the filename, and must not be able to tell a foreign id from
    // an unused one.
    signedInAs(other.id);
    const res = fakeRes();

    await (renderPhotoTransformed as any)(
      fakeReq(`/photos/${privatePhoto.id}/render?v=original`),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe("Photo not found");
    expect(res.headers["Location"]).toBeUndefined();
  });

  it("lets a viewer render a photo from an album shared with them", async () => {
    signedInAs(other.id);
    const res = fakeRes();

    await (renderPhotoTransformed as any)(
      fakeReq(`/photos/${inAlbum.id}/render?v=original`),
      res,
    );

    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`/photos/file/${inAlbum.filename}`);
  });

  it("refuses the export of a photo outside the viewer's scope", async () => {
    signedInAs(other.id);
    const res = fakeRes();

    await (exportPhotoTransformed as any)(
      fakeReq(`/photos/${privatePhoto.id}/export?v=user&user=${owner.id}`),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe("Photo not found");
  });
});
