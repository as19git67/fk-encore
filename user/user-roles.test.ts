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

beforeEach(() => {
  db.delete(rolePermissions).run();
  db.delete(userRoles).run();
  db.delete(users).run();
  db.delete(permissions).run();
  db.delete(roles).run();
});

describe("User-Role Assignments", () => {
  it("should assign a role to a user", () => {
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = createRoleLogic({ name: "Editor" });

    const result = assignRoleLogic({ userId: user.id, roleId: role.id });
    expect(result.userId).toBe(user.id);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].name).toBe("Editor");
  });

  it("should throw when assigning to non-existent user", () => {
    const role = createRoleLogic({ name: "Editor" });
    expect(() => assignRoleLogic({ userId: 9999, roleId: role.id })).toThrow("not found");
  });

  it("should throw when assigning non-existent role", () => {
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    expect(() => assignRoleLogic({ userId: user.id, roleId: 9999 })).toThrow("not found");
  });

  it("should throw when assigning duplicate role", () => {
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = createRoleLogic({ name: "Editor" });
    assignRoleLogic({ userId: user.id, roleId: role.id });
    expect(() => assignRoleLogic({ userId: user.id, roleId: role.id })).toThrow();
  });

  it("should remove a role from a user", () => {
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = createRoleLogic({ name: "Editor" });
    assignRoleLogic({ userId: user.id, roleId: role.id });

    const result = removeRoleLogic(user.id, role.id);
    expect(result.success).toBe(true);

    const roles = getUserRolesLogic(user.id);
    expect(roles.roles).toHaveLength(0);
  });

  it("should throw when removing non-existent assignment", () => {
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = createRoleLogic({ name: "Editor" });
    expect(() => removeRoleLogic(user.id, role.id)).toThrow("does not exist");
  });

  it("should get all roles for a user", () => {
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const r1 = createRoleLogic({ name: "RoleA" });
    const r2 = createRoleLogic({ name: "RoleB" });
    assignRoleLogic({ userId: user.id, roleId: r1.id });
    assignRoleLogic({ userId: user.id, roleId: r2.id });

    const result = getUserRolesLogic(user.id);
    expect(result.roles).toHaveLength(2);
  });
});

describe("Admin Protection", () => {
  it("should prevent deleting the last admin user", () => {
    const admin = createUserLogic({ email: "admin@test.com", name: "Admin", password: "pw" });
    const adminRole = createRoleLogic({ name: "Admin", description: "Full access" });
    assignRoleLogic({ userId: admin.id, roleId: adminRole.id });

    expect(() => deleteUserLogic(admin.id)).toThrow("Cannot delete the last admin user");
  });

  it("should allow deleting an admin if another admin exists", () => {
    const admin1 = createUserLogic({ email: "admin1@test.com", name: "Admin1", password: "pw" });
    const admin2 = createUserLogic({ email: "admin2@test.com", name: "Admin2", password: "pw" });
    const adminRole = createRoleLogic({ name: "Admin", description: "Full access" });
    assignRoleLogic({ userId: admin1.id, roleId: adminRole.id });
    assignRoleLogic({ userId: admin2.id, roleId: adminRole.id });

    const result = deleteUserLogic(admin1.id);
    expect(result.success).toBe(true);
  });

  it("should allow deleting a non-admin user freely", () => {
    const user = createUserLogic({ email: "user@test.com", name: "User", password: "pw" });
    const role = createRoleLogic({ name: "User" });
    assignRoleLogic({ userId: user.id, roleId: role.id });

    const result = deleteUserLogic(user.id);
    expect(result.success).toBe(true);
  });

  it("should prevent removing Admin role from the last admin", () => {
    const admin = createUserLogic({ email: "admin@test.com", name: "Admin", password: "pw" });
    const adminRole = createRoleLogic({ name: "Admin", description: "Full access" });
    assignRoleLogic({ userId: admin.id, roleId: adminRole.id });

    expect(() => removeRoleLogic(admin.id, adminRole.id)).toThrow(
      "Cannot remove the Admin role from the last admin user"
    );
  });

  it("should allow removing Admin role if another admin exists", () => {
    const admin1 = createUserLogic({ email: "a1@test.com", name: "A1", password: "pw" });
    const admin2 = createUserLogic({ email: "a2@test.com", name: "A2", password: "pw" });
    const adminRole = createRoleLogic({ name: "Admin", description: "Full access" });
    assignRoleLogic({ userId: admin1.id, roleId: adminRole.id });
    assignRoleLogic({ userId: admin2.id, roleId: adminRole.id });

    const result = removeRoleLogic(admin1.id, adminRole.id);
    expect(result.success).toBe(true);
  });

  it("should allow removing non-Admin roles freely", () => {
    const user = createUserLogic({ email: "u@test.com", name: "U", password: "pw" });
    const role = createRoleLogic({ name: "Editor" });
    assignRoleLogic({ userId: user.id, roleId: role.id });

    const result = removeRoleLogic(user.id, role.id);
    expect(result.success).toBe(true);
  });
});

