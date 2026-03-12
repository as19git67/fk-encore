import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import {
  createRoleLogic,
  deleteRoleLogic,
  listRolesLogic,
  listPermissionsLogic,
  assignPermissionLogic,
  revokePermissionLogic,
  getPermissionsForRole,
} from "./role.service";
import { createUserLogic, getPermissionsForUser } from "../user/user.service";
import { assignRoleLogic } from "../user/user-roles.service";

function seedPermissions() {
  const perms = [
    { key: "users.list", description: "View user list" },
    { key: "users.read", description: "View user details" },
    { key: "users.create", description: "Create users" },
    { key: "roles.list", description: "View role list" },
    { key: "roles.read", description: "View role details" },
  ];
  for (const p of perms) {
    db.prepare(`INSERT INTO permissions (key, description) VALUES (?, ?)`).run(p.key, p.description);
  }
}

beforeEach(() => {
  db.exec(`DELETE FROM role_permissions`);
  db.exec(`DELETE FROM user_roles`);
  db.exec(`DELETE FROM users`);
  db.exec(`DELETE FROM permissions`);
  db.exec(`DELETE FROM roles`);
});

describe("Permission Management", () => {
  it("should list all permissions", () => {
    seedPermissions();
    const result = listPermissionsLogic();
    expect(result.permissions).toHaveLength(5);
    expect(result.permissions[0].key).toBeDefined();
  });

  it("should assign a permission to a role", () => {
    seedPermissions();
    const role = createRoleLogic({ name: "Editor" });
    const perms = listPermissionsLogic().permissions;
    const perm = perms.find((p) => p.key === "users.list")!;

    const result = assignPermissionLogic(role.id, perm.id);
    expect(result.roleId).toBe(role.id);
    expect(result.permissions).toHaveLength(1);
    expect(result.permissions[0].key).toBe("users.list");
  });

  it("should throw when assigning duplicate permission", () => {
    seedPermissions();
    const role = createRoleLogic({ name: "Editor" });
    const perm = listPermissionsLogic().permissions[0];
    assignPermissionLogic(role.id, perm.id);

    expect(() => assignPermissionLogic(role.id, perm.id)).toThrow("already assigned");
  });

  it("should throw when assigning to non-existent role", () => {
    seedPermissions();
    const perm = listPermissionsLogic().permissions[0];
    expect(() => assignPermissionLogic(9999, perm.id)).toThrow("not found");
  });

  it("should throw when assigning non-existent permission", () => {
    const role = createRoleLogic({ name: "Editor" });
    expect(() => assignPermissionLogic(role.id, 9999)).toThrow("not found");
  });

  it("should revoke a permission from a role", () => {
    seedPermissions();
    const role = createRoleLogic({ name: "Editor" });
    const perm = listPermissionsLogic().permissions[0];
    assignPermissionLogic(role.id, perm.id);

    const result = revokePermissionLogic(role.id, perm.id);
    expect(result.success).toBe(true);

    const permsAfter = getPermissionsForRole(role.id);
    expect(permsAfter).toHaveLength(0);
  });

  it("should throw when revoking non-existent assignment", () => {
    seedPermissions();
    const role = createRoleLogic({ name: "Editor" });
    const perm = listPermissionsLogic().permissions[0];
    expect(() => revokePermissionLogic(role.id, perm.id)).toThrow("does not exist");
  });

  it("should list roles with their permissions", () => {
    seedPermissions();
    const role = createRoleLogic({ name: "Editor" });
    const perms = listPermissionsLogic().permissions;
    assignPermissionLogic(role.id, perms[0].id);
    assignPermissionLogic(role.id, perms[1].id);

    const result = listRolesLogic();
    const editor = result.roles.find((r) => r.name === "Editor")!;
    expect(editor.permissions).toHaveLength(2);
  });
});

describe("Permission Resolution (User → Roles → Permissions)", () => {
  it("should resolve permissions for a user through roles", () => {
    seedPermissions();
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = createRoleLogic({ name: "Editor" });
    const perms = listPermissionsLogic().permissions;

    assignPermissionLogic(role.id, perms.find((p) => p.key === "users.list")!.id);
    assignPermissionLogic(role.id, perms.find((p) => p.key === "users.read")!.id);
    assignRoleLogic({ userId: user.id, roleId: role.id });

    const userPerms = getPermissionsForUser(user.id);
    expect(userPerms).toContain("users.list");
    expect(userPerms).toContain("users.read");
    expect(userPerms).not.toContain("roles.list");
  });

  it("should return no permissions for a user without roles", () => {
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const userPerms = getPermissionsForUser(user.id);
    expect(userPerms).toHaveLength(0);
  });

  it("should merge permissions from multiple roles without duplicates", () => {
    seedPermissions();
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const r1 = createRoleLogic({ name: "RoleA" });
    const r2 = createRoleLogic({ name: "RoleB" });
    const perms = listPermissionsLogic().permissions;

    const usersListPerm = perms.find((p) => p.key === "users.list")!;
    const usersReadPerm = perms.find((p) => p.key === "users.read")!;
    const rolesListPerm = perms.find((p) => p.key === "roles.list")!;

    // Both roles have users.list, r1 has users.read, r2 has roles.list
    assignPermissionLogic(r1.id, usersListPerm.id);
    assignPermissionLogic(r1.id, usersReadPerm.id);
    assignPermissionLogic(r2.id, usersListPerm.id);
    assignPermissionLogic(r2.id, rolesListPerm.id);

    assignRoleLogic({ userId: user.id, roleId: r1.id });
    assignRoleLogic({ userId: user.id, roleId: r2.id });

    const userPerms = getPermissionsForUser(user.id);
    // Should be deduplicated
    expect(userPerms).toHaveLength(3);
    expect(userPerms).toContain("users.list");
    expect(userPerms).toContain("users.read");
    expect(userPerms).toContain("roles.list");
  });
});

describe("Admin Role Deletion Protection", () => {
  it("should prevent deleting Admin role with assigned users", () => {
    const user = createUserLogic({ email: "a@test.com", name: "A", password: "pw" });
    const adminRole = createRoleLogic({ name: "Admin", description: "Full access" });
    assignRoleLogic({ userId: user.id, roleId: adminRole.id });

    expect(() => deleteRoleLogic(adminRole.id)).toThrow(
      "Cannot delete the Admin role while users are assigned to it"
    );
  });

  it("should allow deleting Admin role with no assigned users", () => {
    const adminRole = createRoleLogic({ name: "Admin", description: "Full access" });
    const result = deleteRoleLogic(adminRole.id);
    expect(result.success).toBe(true);
  });

  it("should allow deleting non-Admin roles with assigned users", () => {
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = createRoleLogic({ name: "Editor" });
    assignRoleLogic({ userId: user.id, roleId: role.id });

    // Non-Admin roles can be deleted (CASCADE removes assignments)
    const result = deleteRoleLogic(role.id);
    expect(result.success).toBe(true);
  });
});

