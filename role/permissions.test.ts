import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import { rolePermissions, userRoles, users, permissions, roles } from "../db/schema";
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

async function seedPermissions() {
  const perms = [
    { key: "users.list", description: "View user list" },
    { key: "users.read", description: "View user details" },
    { key: "users.create", description: "Create users" },
    { key: "roles.list", description: "View role list" },
    { key: "roles.read", description: "View role details" },
  ];
  for (const p of perms) {
    await db.insert(permissions).values(p);
  }
}

beforeEach(async () => {
  await db.delete(rolePermissions);
  await db.delete(userRoles);
  await db.delete(users);
  await db.delete(permissions);
  await db.delete(roles);
});

describe("Permission Management", () => {
  it("should list all permissions", async () => {
    await seedPermissions();
    const result = await listPermissionsLogic();
    expect(result.permissions).toHaveLength(5);
    expect(result.permissions[0].key).toBeDefined();
  });

  it("should assign a permission to a role", async () => {
    await seedPermissions();
    const role = await createRoleLogic({ name: "Editor" });
    const perms = (await listPermissionsLogic()).permissions;
    const perm = perms.find((p) => p.key === "users.list")!;

    const result = await assignPermissionLogic(role.id, perm.id);
    expect(result.roleId).toBe(role.id);
    expect(result.permissions).toHaveLength(1);
    expect(result.permissions[0].key).toBe("users.list");
  });

  it("should throw when assigning duplicate permission", async () => {
    await seedPermissions();
    const role = await createRoleLogic({ name: "Editor" });
    const perm = (await listPermissionsLogic()).permissions[0];
    await assignPermissionLogic(role.id, perm.id);

    await expect(assignPermissionLogic(role.id, perm.id)).rejects.toThrow("already assigned");
  });

  it("should throw when assigning to non-existent role", async () => {
    await seedPermissions();
    const perm = (await listPermissionsLogic()).permissions[0];
    await expect(assignPermissionLogic(9999, perm.id)).rejects.toThrow("not found");
  });

  it("should throw when assigning non-existent permission", async () => {
    const role = await createRoleLogic({ name: "Editor" });
    await expect(assignPermissionLogic(role.id, 9999)).rejects.toThrow("not found");
  });

  it("should revoke a permission from a role", async () => {
    await seedPermissions();
    const role = await createRoleLogic({ name: "Editor" });
    const perm = (await listPermissionsLogic()).permissions[0];
    await assignPermissionLogic(role.id, perm.id);

    const result = await revokePermissionLogic(role.id, perm.id);
    expect(result.success).toBe(true);

    const permsAfter = await getPermissionsForRole(role.id);
    expect(permsAfter).toHaveLength(0);
  });

  it("should throw when revoking non-existent assignment", async () => {
    await seedPermissions();
    const role = await createRoleLogic({ name: "Editor" });
    const perm = (await listPermissionsLogic()).permissions[0];
    await expect(revokePermissionLogic(role.id, perm.id)).rejects.toThrow("does not exist");
  });

  it("should list roles with their permissions", async () => {
    await seedPermissions();
    const role = await createRoleLogic({ name: "Editor" });
    const perms = (await listPermissionsLogic()).permissions;
    await assignPermissionLogic(role.id, perms[0].id);
    await assignPermissionLogic(role.id, perms[1].id);

    const result = await listRolesLogic();
    const editor = result.roles.find((r) => r.name === "Editor")!;
    expect(editor.permissions).toHaveLength(2);
  });
});

describe("Permission Resolution (User → Roles → Permissions)", () => {
  it("should resolve permissions for a user through roles", async () => {
    await seedPermissions();
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = await createRoleLogic({ name: "Editor" });
    const perms = (await listPermissionsLogic()).permissions;

    await assignPermissionLogic(role.id, perms.find((p) => p.key === "users.list")!.id);
    await assignPermissionLogic(role.id, perms.find((p) => p.key === "users.read")!.id);
    await assignRoleLogic({ userId: user.id, roleId: role.id });

    const userPerms = await getPermissionsForUser(user.id);
    expect(userPerms).toContain("users.list");
    expect(userPerms).toContain("users.read");
    expect(userPerms).not.toContain("roles.list");
  });

  it("should return no permissions for a user without roles", async () => {
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const userPerms = await getPermissionsForUser(user.id);
    expect(userPerms).toHaveLength(0);
  });

  it("should merge permissions from multiple roles without duplicates", async () => {
    await seedPermissions();
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const r1 = await createRoleLogic({ name: "RoleA" });
    const r2 = await createRoleLogic({ name: "RoleB" });
    const perms = (await listPermissionsLogic()).permissions;

    const usersListPerm = perms.find((p) => p.key === "users.list")!;
    const usersReadPerm = perms.find((p) => p.key === "users.read")!;
    const rolesListPerm = perms.find((p) => p.key === "roles.list")!;

    // Both roles have users.list, r1 has users.read, r2 has roles.list
    await assignPermissionLogic(r1.id, usersListPerm.id);
    await assignPermissionLogic(r1.id, usersReadPerm.id);
    await assignPermissionLogic(r2.id, usersListPerm.id);
    await assignPermissionLogic(r2.id, rolesListPerm.id);

    await assignRoleLogic({ userId: user.id, roleId: r1.id });
    await assignRoleLogic({ userId: user.id, roleId: r2.id });

    const userPerms = await getPermissionsForUser(user.id);
    // Should be deduplicated
    expect(userPerms).toHaveLength(3);
    expect(userPerms).toContain("users.list");
    expect(userPerms).toContain("users.read");
    expect(userPerms).toContain("roles.list");
  });
});

describe("Admin Role Deletion Protection", () => {
  it("should prevent deleting Admin role with assigned users", async () => {
    const user = await createUserLogic({ email: "a@test.com", name: "A", password: "pw" });
    const adminRole = await createRoleLogic({ name: "Admin", description: "Full access" });
    await assignRoleLogic({ userId: user.id, roleId: adminRole.id });

    await expect(deleteRoleLogic(adminRole.id)).rejects.toThrow(
      "Cannot delete the Admin role while users are assigned to it"
    );
  });

  it("should allow deleting Admin role with no assigned users", async () => {
    const adminRole = await createRoleLogic({ name: "Admin", description: "Full access" });
    const result = await deleteRoleLogic(adminRole.id);
    expect(result.success).toBe(true);
  });

  it("should allow deleting non-Admin roles with assigned users", async () => {
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = await createRoleLogic({ name: "Editor" });
    await assignRoleLogic({ userId: user.id, roleId: role.id });

    // Non-Admin roles can be deleted (CASCADE removes assignments)
    const result = await deleteRoleLogic(role.id);
    expect(result.success).toBe(true);
  });
});
