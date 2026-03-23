import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import { sessions, rolePermissions, userRoles, users, permissions, roles } from "../db/schema";
import { loginLogic, logoutLogic, validateToken } from "./auth.service";
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
});
