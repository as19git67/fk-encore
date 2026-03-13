import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import { sessions, rolePermissions, userRoles, users, permissions, roles } from "../db/schema";
import { loginLogic, logoutLogic, validateToken } from "./auth.service";
import { createUserLogic, getPermissionsForUser } from "./user.service";
import { createRoleLogic } from "../role/role.service";
import { assignRoleLogic } from "./user-roles.service";
import { assignPermissionLogic } from "../role/role.service";

function seedPermissions() {
  const perms = [
    { key: "users.list", description: "View user list" },
    { key: "users.read", description: "View user details" },
  ];
  for (const p of perms) {
    db.insert(permissions).values(p).run();
  }
}

beforeEach(() => {
  db.delete(sessions).run();
  db.delete(rolePermissions).run();
  db.delete(userRoles).run();
  db.delete(users).run();
  db.delete(permissions).run();
  db.delete(roles).run();
});

describe("Auth Logic", () => {
  it("should login with valid credentials and return user with permissions", () => {
    seedPermissions();
    const user = createUserLogic({ email: "u@test.com", name: "User", password: "secret123" });
    const role = createRoleLogic({ name: "Editor" });
    const perms = db.select().from(permissions).all();
    assignPermissionLogic(role.id, perms[0].id);
    assignRoleLogic({ userId: user.id, roleId: role.id });

    const result = loginLogic({ email: "u@test.com", password: "secret123" });

    expect(result.token).toBeDefined();
    expect(result.user.id).toBe(user.id);
    expect(result.user.email).toBe("u@test.com");
    expect(result.user.roles).toHaveLength(1);
    expect(result.user.permissions).toContain("users.list");
  });

  it("should throw on invalid email", () => {
    createUserLogic({ email: "u@test.com", name: "User", password: "secret123" });
    expect(() => loginLogic({ email: "wrong@test.com", password: "secret123" })).toThrow("invalid credentials");
  });

  it("should throw on invalid password", () => {
    createUserLogic({ email: "u@test.com", name: "User", password: "secret123" });
    expect(() => loginLogic({ email: "u@test.com", password: "wrong" })).toThrow("invalid credentials");
  });

  it("should throw on empty email or password", () => {
    expect(() => loginLogic({ email: "", password: "pw" })).toThrow("required");
    expect(() => loginLogic({ email: "a@b.c", password: "" })).toThrow("required");
  });

  it("should validate a token and return permissions", () => {
    seedPermissions();
    const user = createUserLogic({ email: "u@test.com", name: "User", password: "pw" });
    const role = createRoleLogic({ name: "Viewer" });
    const perms = db.select().from(permissions).all();
    assignPermissionLogic(role.id, perms[0].id);
    assignRoleLogic({ userId: user.id, roleId: role.id });

    const { token } = loginLogic({ email: "u@test.com", password: "pw" });
    const authData = validateToken(token);

    expect(authData.userID).toBe(String(user.id));
    expect(authData.permissions).toContain("users.list");
  });

  it("should throw on invalid token", () => {
    expect(() => validateToken("nonexistent-token")).toThrow("invalid or expired");
  });

  it("should logout and invalidate the token", () => {
    createUserLogic({ email: "u@test.com", name: "User", password: "pw" });
    const { token } = loginLogic({ email: "u@test.com", password: "pw" });

    const result = logoutLogic(token);
    expect(result.success).toBe(true);

    expect(() => validateToken(token)).toThrow("invalid or expired");
  });

  it("should return empty permissions for user without roles", () => {
    createUserLogic({ email: "u@test.com", name: "User", password: "pw" });
    const { token } = loginLogic({ email: "u@test.com", password: "pw" });

    const authData = validateToken(token);
    expect(authData.permissions).toHaveLength(0);
  });
});
