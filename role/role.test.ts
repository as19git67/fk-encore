import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import {
  createRoleLogic,
  getRoleLogic,
  listRolesLogic,
  updateRoleLogic,
  deleteRoleLogic,
} from "./role.logic";

// Clean up tables before each test
beforeEach(() => {
  db.exec(`DELETE FROM user_roles`);
  db.exec(`DELETE FROM users`);
  db.exec(`DELETE FROM roles`);
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
