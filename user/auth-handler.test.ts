import { describe, it, expect, afterEach, vi } from "vitest";
import { currentRequest } from "encore.dev";
import { requirePermission, getAuthToken, MEDIA_SCOPE_PERMISSIONS } from "./auth-handler";
import { APIError } from "encore.dev/api";

// Note: The authHandler itself and Gateway require the Encore runtime and
// cannot be unit-tested here. We test the pure helper functions instead.

describe("requirePermission", () => {
  const authData = {
    userID: "42",
    permissions: ["users.read", "users.list", "photos.upload"],
  };

  it("does not throw when permission is present", () => {
    expect(() => requirePermission(authData, "users.read")).not.toThrow();
    expect(() => requirePermission(authData, "photos.upload")).not.toThrow();
  });

  it("throws APIError.permissionDenied when permission is missing", () => {
    expect(() => requirePermission(authData, "admin.delete")).toThrow();
    try {
      requirePermission(authData, "admin.delete");
    } catch (err) {
      expect(err).toBeInstanceOf(APIError);
      expect((err as APIError).code).toBe("permission_denied");
      expect((err as APIError).message).toContain("admin.delete");
    }
  });

  it("throws for empty permissions list", () => {
    const noPerms = { userID: "1", permissions: [] };
    expect(() => requirePermission(noPerms, "any.permission")).toThrow();
  });

  it("is case-sensitive for permission keys", () => {
    expect(() => requirePermission(authData, "Users.Read")).toThrow();
    expect(() => requirePermission(authData, "USERS.READ")).toThrow();
    expect(() => requirePermission(authData, "users.read")).not.toThrow();
  });
});

// A token passed as `?token=` is the same session token, but it travels
// through access logs, browser history and any URL somebody pastes. It used
// to be worth exactly as much as a bearer header — a leaked image URL was a
// 15-minute run of the account. requirePermission is the choke point every
// gated endpoint goes through, so the ceiling is applied there.
describe("requirePermission — media scope", () => {
  const adminViaUrl = {
    userID: "1",
    permissions: [
      "module.photos",
      "photos.view",
      "photos.delete",
      "module.documents",
      "documents.view",
      "documents.delete",
      "users.delete",
      "roles.assign",
      "data.manage",
    ],
    scope: "media" as const,
  };

  it("still grants what the URL-bearing endpoints need", () => {
    for (const p of ["module.photos", "photos.view", "module.documents", "documents.view"]) {
      expect(() => requirePermission(adminViaUrl, p)).not.toThrow();
    }
  });

  it("refuses everything else, even though the account holds it", () => {
    for (const p of ["photos.delete", "documents.delete", "users.delete", "roles.assign", "data.manage"]) {
      expect(() => requirePermission(adminViaUrl, p)).toThrow(/URL-borne/);
    }
  });

  it("does not grant a permission the account lacks", () => {
    const limited = { userID: "2", permissions: ["module.photos"], scope: "media" as const };
    expect(() => requirePermission(limited, "photos.view")).toThrow(/missing permission/);
  });

  it("leaves a header-authenticated caller alone", () => {
    const viaHeader = { ...adminViaUrl, scope: "full" as const };
    expect(() => requirePermission(viaHeader, "users.delete")).not.toThrow();
  });

  it("treats an absent scope as full", () => {
    const { scope: _dropped, ...noScope } = adminViaUrl;
    expect(() => requirePermission(noScope, "users.delete")).not.toThrow();
  });

  it("keeps the media allowlist to read permissions only", () => {
    // A write permission slipping into this set would quietly undo the
    // whole thing, so pin the contents rather than only the behaviour.
    expect([...MEDIA_SCOPE_PERMISSIONS].sort()).toEqual([
      "documents.view",
      "module.documents",
      "module.photos",
      "photos.view",
    ]);
  });
});

// getAuthToken reads the token off the request being handled. It used to
// return a module-level variable that every authenticated request overwrote,
// which let logout revoke a different user's session under concurrency.
describe("getAuthToken", () => {
  function stubRequest(meta: Record<string, unknown> | undefined) {
    vi.mocked(currentRequest).mockReturnValue(meta as never);
  }

  afterEach(() => {
    vi.mocked(currentRequest).mockReturnValue({
      type: "api-call",
      headers: {},
    } as never);
  });

  it("returns the bearer token of the current request", () => {
    stubRequest({ type: "api-call", headers: { authorization: "Bearer tok-abc" } });
    expect(getAuthToken()).toBe("tok-abc");
  });

  it("returns undefined when there is no Authorization header", () => {
    stubRequest({ type: "api-call", headers: {} });
    expect(getAuthToken()).toBeUndefined();
  });

  it("rejects a malformed Authorization header", () => {
    stubRequest({ type: "api-call", headers: { authorization: "tok-abc" } });
    expect(getAuthToken()).toBeUndefined();

    stubRequest({ type: "api-call", headers: { authorization: "Basic dXNlcjpwdw==" } });
    expect(getAuthToken()).toBeUndefined();
  });

  it("falls back to the ?token= query parameter used by WebSocket handshakes", () => {
    stubRequest({
      type: "api-call",
      headers: {},
      pathAndQuery: "/realtime/subscribe?token=tok-ws&channels=feed",
    });
    expect(getAuthToken()).toBe("tok-ws");
  });

  it("returns undefined outside an API call", () => {
    stubRequest({ type: "pubsub-message" });
    expect(getAuthToken()).toBeUndefined();
    stubRequest(undefined);
    expect(getAuthToken()).toBeUndefined();
  });

  it("tracks the request it is called for, not the last one authenticated", () => {
    // The regression this guards: two concurrent requests, and the token the
    // second one authenticated with must not leak into the first one's logout.
    stubRequest({ type: "api-call", headers: { authorization: "Bearer alice" } });
    const alice = getAuthToken();

    stubRequest({ type: "api-call", headers: { authorization: "Bearer bob" } });
    const bob = getAuthToken();

    expect(alice).toBe("alice");
    expect(bob).toBe("bob");
  });
});
