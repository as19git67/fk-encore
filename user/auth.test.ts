import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import { sessions, refreshTokens, rolePermissions, userRoles, users, permissions, roles } from "../db/schema";
import { loginLogic, logoutLogic, refreshTokenLogic, validateToken } from "./auth.service";
import { createUserLogic, getPermissionsForUser } from "./user.service";
import { createRoleLogic } from "../role/role.service";
import { assignRoleLogic } from "./user-roles.service";
import { assignPermissionLogic } from "../role/role.service";

async function seedPermissions() {
  const perms = [
    { key: "users.list", description: "View user list" },
    { key: "users.read", description: "View user details" },
  ];
  for (const p of perms) {
    await db.insert(permissions).values(p);
  }
}

beforeEach(async () => {
  await db.delete(refreshTokens);
  await db.delete(sessions);
  await db.delete(rolePermissions);
  await db.delete(userRoles);
  await db.delete(users);
  await db.delete(permissions);
  await db.delete(roles);
});

describe("Auth Logic", () => {
  it("should login with valid credentials and return user with permissions", async () => {
    await seedPermissions();
    const user = await createUserLogic({ email: "u@test.com", name: "User", password: "secret123" });
    const role = await createRoleLogic({ name: "Editor" });
    const perms = await db.select().from(permissions);
    await assignPermissionLogic(role.id, perms[0].id);
    await assignRoleLogic({ userId: user.id, roleId: role.id });

    const result = await loginLogic({ email: "u@test.com", password: "secret123" });

    expect(result.token).toBeDefined();
    expect(result.user.id).toBe(user.id);
    expect(result.user.email).toBe("u@test.com");
    expect(result.user.roles).toHaveLength(1);
    expect(result.user.permissions).toContain("users.list");
  });

  it("should throw on invalid email", async () => {
    await createUserLogic({ email: "u@test.com", name: "User", password: "secret123" });
    await expect(loginLogic({ email: "wrong@test.com", password: "secret123" })).rejects.toThrow("invalid credentials");
  });

  it("should throw on invalid password", async () => {
    await createUserLogic({ email: "u@test.com", name: "User", password: "secret123" });
    await expect(loginLogic({ email: "u@test.com", password: "wrong" })).rejects.toThrow("invalid credentials");
  });

  it("should throw on empty email or password", async () => {
    await expect(loginLogic({ email: "", password: "pw" })).rejects.toThrow("required");
    await expect(loginLogic({ email: "a@b.c", password: "" })).rejects.toThrow("required");
  });

  it("should validate a token and return permissions", async () => {
    await seedPermissions();
    const user = await createUserLogic({ email: "u@test.com", name: "User", password: "pw" });
    const role = await createRoleLogic({ name: "Viewer" });
    const perms = await db.select().from(permissions);
    await assignPermissionLogic(role.id, perms[0].id);
    await assignRoleLogic({ userId: user.id, roleId: role.id });

    const { token } = await loginLogic({ email: "u@test.com", password: "pw" });
    const authData = await validateToken(token);

    expect(authData.userID).toBe(String(user.id));
    expect(authData.permissions).toContain("users.list");
  });

  it("should throw on invalid token", async () => {
    await expect(validateToken("nonexistent-token")).rejects.toThrow("invalid or expired");
  });

  it("should logout and invalidate the token", async () => {
    await createUserLogic({ email: "u@test.com", name: "User", password: "pw" });
    const { token } = await loginLogic({ email: "u@test.com", password: "pw" });

    const result = await logoutLogic(token);
    expect(result.success).toBe(true);

    await expect(validateToken(token)).rejects.toThrow("invalid or expired");
  });

  it("should return empty permissions for user without roles", async () => {
    await createUserLogic({ email: "u@test.com", name: "User", password: "pw" });
    const { token } = await loginLogic({ email: "u@test.com", password: "pw" });

    const authData = await validateToken(token);
    expect(authData.permissions).toHaveLength(0);
  });

  it("returns an access-token expiry roughly 15 minutes in the future", async () => {
    await createUserLogic({ email: "u@test.com", name: "User", password: "pw" });
    const result = await loginLogic({ email: "u@test.com", password: "pw" });

    expect(result.expiresAt).toBeDefined();
    const ms = new Date(result.expiresAt).getTime() - Date.now();
    // 15-minute TTL; allow a generous lower bound for slow CI.
    expect(ms).toBeGreaterThan(13 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(15 * 60 * 1000 + 2000);
  });

  it("refresh rotates the token pair and returns a fresh expiry", async () => {
    await createUserLogic({ email: "u@test.com", name: "User", password: "pw" });
    const login = await loginLogic({ email: "u@test.com", password: "pw" });

    const refreshed = await refreshTokenLogic({ refreshToken: login.refreshToken });

    expect(refreshed.token).toBeDefined();
    expect(refreshed.token).not.toBe(login.token);
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
    expect(refreshed.expiresAt).toBeDefined();
    // The newly issued access token must validate.
    const authData = await validateToken(refreshed.token);
    expect(authData.userID).toBeDefined();
  });

  it("keeps the old refresh token valid during the grace period after rotation", async () => {
    // Guards the lost-response race: when a rotation's response never reaches
    // the client (e.g. a suspended iOS background task), the client still holds
    // the previous refresh token. It must keep working long enough to retry,
    // otherwise the next launch fails to refresh and the user is logged out.
    await createUserLogic({ email: "u@test.com", name: "User", password: "pw" });
    const login = await loginLogic({ email: "u@test.com", password: "pw" });

    await refreshTokenLogic({ refreshToken: login.refreshToken });
    // Reuse the original (now-rotated) refresh token within the grace period.
    const second = await refreshTokenLogic({ refreshToken: login.refreshToken });

    expect(second.token).toBeDefined();
    expect(second.expiresAt).toBeDefined();
  });
});
