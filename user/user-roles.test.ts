import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import { rolePermissions, userRoles, users, permissions, roles } from "../db/schema";
import {
  assignRoleLogic,
  removeRoleLogic,
  getUserRolesLogic,
} from "./user-roles.service";
import { createUserLogic, deleteUserLogic } from "./user.service";
import { createRoleLogic } from "../role/role.service";

beforeEach(async () => {
  await db.delete(rolePermissions);
  await db.delete(userRoles);
  await db.delete(users);
  await db.delete(permissions);
  await db.delete(roles);
});

describe("User-Role Assignments", () => {
  it("should assign a role to a user", async () => {
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = await createRoleLogic({ name: "Editor" });

    const result = await assignRoleLogic({ userId: user.id, roleId: role.id });
    expect(result.userId).toBe(user.id);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].name).toBe("Editor");
  });

  it("should throw when assigning to non-existent user", async () => {
    const role = await createRoleLogic({ name: "Editor" });
    await expect(assignRoleLogic({ userId: 9999, roleId: role.id })).rejects.toThrow("not found");
  });

  it("should throw when assigning non-existent role", async () => {
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    await expect(assignRoleLogic({ userId: user.id, roleId: 9999 })).rejects.toThrow("not found");
  });

  it("should throw when assigning duplicate role", async () => {
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = await createRoleLogic({ name: "Editor" });
    await assignRoleLogic({ userId: user.id, roleId: role.id });
    await expect(assignRoleLogic({ userId: user.id, roleId: role.id })).rejects.toThrow();
  });

  it("should remove a role from a user", async () => {
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = await createRoleLogic({ name: "Editor" });
    await assignRoleLogic({ userId: user.id, roleId: role.id });

    const result = await removeRoleLogic(user.id, role.id);
    expect(result.success).toBe(true);

    const rolesResult = await getUserRolesLogic(user.id);
    expect(rolesResult.roles).toHaveLength(0);
  });

  it("should throw when removing non-existent assignment", async () => {
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = await createRoleLogic({ name: "Editor" });
    await expect(removeRoleLogic(user.id, role.id)).rejects.toThrow("does not exist");
  });

  it("should get all roles for a user", async () => {
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const r1 = await createRoleLogic({ name: "RoleA" });
    const r2 = await createRoleLogic({ name: "RoleB" });
    await assignRoleLogic({ userId: user.id, roleId: r1.id });
    await assignRoleLogic({ userId: user.id, roleId: r2.id });

    const result = await getUserRolesLogic(user.id);
    expect(result.roles).toHaveLength(2);
  });
});

describe("Admin Protection", () => {
  it("should prevent deleting the last admin user", async () => {
    const admin = await createUserLogic({ email: "admin@test.com", name: "Admin", password: "pw" });
    const adminRole = await createRoleLogic({ name: "Admin", description: "Full access" });
    await assignRoleLogic({ userId: admin.id, roleId: adminRole.id });

    await expect(deleteUserLogic(admin.id)).rejects.toThrow("Cannot delete the last admin user");
  });

  it("should allow deleting an admin if another admin exists", async () => {
    const admin1 = await createUserLogic({ email: "admin1@test.com", name: "Admin1", password: "pw" });
    const admin2 = await createUserLogic({ email: "admin2@test.com", name: "Admin2", password: "pw" });
    const adminRole = await createRoleLogic({ name: "Admin", description: "Full access" });
    await assignRoleLogic({ userId: admin1.id, roleId: adminRole.id });
    await assignRoleLogic({ userId: admin2.id, roleId: adminRole.id });

    const result = await deleteUserLogic(admin1.id);
    expect(result.success).toBe(true);
  });

  it("should allow deleting a non-admin user freely", async () => {
    const user = await createUserLogic({ email: "user@test.com", name: "User", password: "pw" });
    const role = await createRoleLogic({ name: "User" });
    await assignRoleLogic({ userId: user.id, roleId: role.id });

    const result = await deleteUserLogic(user.id);
    expect(result.success).toBe(true);
  });

  it("should prevent removing Admin role from the last admin", async () => {
    const admin = await createUserLogic({ email: "admin@test.com", name: "Admin", password: "pw" });
    const adminRole = await createRoleLogic({ name: "Admin", description: "Full access" });
    await assignRoleLogic({ userId: admin.id, roleId: adminRole.id });

    await expect(removeRoleLogic(admin.id, adminRole.id)).rejects.toThrow(
      "Cannot remove the Admin role from the last admin user"
    );
  });

  it("should allow removing Admin role if another admin exists", async () => {
    const admin1 = await createUserLogic({ email: "a1@test.com", name: "A1", password: "pw" });
    const admin2 = await createUserLogic({ email: "a2@test.com", name: "A2", password: "pw" });
    const adminRole = await createRoleLogic({ name: "Admin", description: "Full access" });
    await assignRoleLogic({ userId: admin1.id, roleId: adminRole.id });
    await assignRoleLogic({ userId: admin2.id, roleId: adminRole.id });

    const result = await removeRoleLogic(admin1.id, adminRole.id);
    expect(result.success).toBe(true);
  });

  it("should allow removing non-Admin roles freely", async () => {
    const user = await createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = await createRoleLogic({ name: "Editor" });
    await assignRoleLogic({ userId: user.id, roleId: role.id });

    const result = await removeRoleLogic(user.id, role.id);
    expect(result.success).toBe(true);
  });
});
