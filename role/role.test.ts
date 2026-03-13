import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import { rolePermissions, userRoles, users, permissions, roles } from "../db/schema";
import {
  createRoleLogic,
  getRoleLogic,
  listRolesLogic,
  updateRoleLogic,
  deleteRoleLogic,
} from "./role.service";

// Clean up tables before each test
beforeEach(() => {
  db.delete(rolePermissions).run();
  db.delete(userRoles).run();
  db.delete(users).run();
  db.delete(permissions).run();
  db.delete(roles).run();
});

describe("Role Service", () => {
  it("should create a role", () => {
    const role = createRoleLogic({
      name: "admin",
      description: "Test role",
    });

    expect(role.id).toBeDefined();
    expect(role.name).toBe("admin");
    expect(role.description).toBe("Test role");
  });

  it("should get a role by ID", () => {
    const created = createRoleLogic({
      name: "viewer",
      description: "Fetch me",
    });

    const fetched = getRoleLogic(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("viewer");
    expect(fetched.users).toEqual([]);
  });

  it("should list roles", () => {
    createRoleLogic({ name: "role-a" });
    createRoleLogic({ name: "role-b" });

    const result = listRolesLogic();
    expect(result.roles).toHaveLength(2);
  });

  it("should update a role", () => {
    const created = createRoleLogic({
      name: "editor",
      description: "Before",
    });

    const updated = updateRoleLogic({
      id: created.id,
      description: "After",
    });

    expect(updated.description).toBe("After");
    expect(updated.name).toBe("editor");
  });

  it("should delete a role", () => {
    const created = createRoleLogic({
      name: "temp-role",
    });

    const result = deleteRoleLogic(created.id);
    expect(result.success).toBe(true);

    expect(() => getRoleLogic(created.id)).toThrow("not found");
  });

  it("should throw on duplicate name", () => {
    createRoleLogic({ name: "unique-role" });
    expect(() => createRoleLogic({ name: "unique-role" })).toThrow();
  });

  it("should throw on missing name", () => {
    expect(() => createRoleLogic({ name: "" })).toThrow("required");
  });
});
