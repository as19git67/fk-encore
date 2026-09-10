// Authorization tests for the raw photo-rendering endpoints.
//
// /photos/:id/render and /photos/:id/export are addressed by the photo's
// sequential id. While they were `auth: false`, anyone could walk id=1,2,3,…
// and pull the whole library, and `v=original` additionally answered with
// the photo's filename — the one thing /photos/file/* relies on not being
// guessable. These tests pin the gate that closed that.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
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
