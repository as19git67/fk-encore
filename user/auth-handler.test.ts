import { describe, it, expect, afterEach, vi } from "vitest";
import { currentRequest } from "encore.dev";
import { requirePermission, getAuthToken } from "./auth-handler";
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
