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
beforeEach(async () => {
  await db.delete(rolePermissions);
  await db.delete(userRoles);
  await db.delete(users);
  await db.delete(permissions);
  await db.delete(roles);
});

describe("Role Service", () => {
  it("should create a role", async () => {
    const role = await createRoleLogic({
      name: "admin",
      description: "Test role",
    });

    expect(role.id).toBeDefined();
    expect(role.name).toBe("admin");
    expect(role.description).toBe("Test role");
  });

  it("should get a role by ID", async () => {
    const created = await createRoleLogic({
      name: "viewer",
      description: "Fetch me",
    });

    const fetched = await getRoleLogic(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("viewer");
    expect(fetched.users).toEqual([]);
  });

  it("should list roles", async () => {
    await createRoleLogic({ name: "role-a" });
    await createRoleLogic({ name: "role-b" });

    const result = await listRolesLogic();
    expect(result.roles).toHaveLength(2);
  });

  it("should update a role", async () => {
    const created = await createRoleLogic({
      name: "editor",
      description: "Before",
    });

    const updated = await updateRoleLogic({
      id: created.id,
      description: "After",
    });

    expect(updated.description).toBe("After");
    expect(updated.name).toBe("editor");
  });

  it("should delete a role", async () => {
    const created = await createRoleLogic({
      name: "temp-role",
    });

    const result = await deleteRoleLogic(created.id);
    expect(result.success).toBe(true);

    await expect(getRoleLogic(created.id)).rejects.toThrow("not found");
  });

  it("should throw on duplicate name", async () => {
    await createRoleLogic({ name: "unique-role" });
    await expect(createRoleLogic({ name: "unique-role" })).rejects.toThrow();
  });

  it("should throw on missing name", async () => {
    await expect(createRoleLogic({ name: "" })).rejects.toThrow("required");
  });
});
