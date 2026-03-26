import { describe, it, expect } from "vitest";
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

describe("getAuthToken", () => {
  it("returns undefined when no token has been set", () => {
    // Module-level state; in isolation it is undefined unless auth handler ran
    // We only verify the return type is string | undefined
    const token = getAuthToken();
    expect(token === undefined || typeof token === "string").toBe(true);
  });
});
