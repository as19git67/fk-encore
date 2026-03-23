import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import { rolePermissions, userRoles, sessions, users, permissions, roles } from "../db/schema";
import {
  createUserLogic,
  getUserLogic,
  listUsersLogic,
  updateUserLogic,
  deleteUserLogic,
} from "./user.service";

// Clean up tables before each test
beforeEach(async () => {
  await db.delete(rolePermissions);
  await db.delete(userRoles);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(permissions);
  await db.delete(roles);
});

describe("User Service", () => {
  it("should create a user", async () => {
    const user = await createUserLogic({
      email: "test@example.com",
      name: "Test User",
      password: "securepassword123",
    });

    expect(user.id).toBeDefined();
    expect(user.name).toBe("Test User");
    expect(user.email).toBe("test@example.com");
    expect(user.roles).toEqual([]);
    // password_hash should never be exposed
    expect((user as any).password_hash).toBeUndefined();
  });

  it("should get a user by ID", async () => {
    const created = await createUserLogic({
      email: "get@example.com",
      name: "Get User",
      password: "password",
    });

    const fetched = await getUserLogic(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.email).toBe(created.email);
  });

  it("should list users", async () => {
    await createUserLogic({ email: "a@example.com", name: "A", password: "pw" });
    await createUserLogic({ email: "b@example.com", name: "B", password: "pw" });

    const result = await listUsersLogic();
    expect(result.users).toHaveLength(2);
  });

  it("should update a user", async () => {
    const created = await createUserLogic({
      email: "update@example.com",
      name: "Before Update",
      password: "password",
    });

    const updated = await updateUserLogic({
      id: created.id,
      name: "After Update",
    });

    expect(updated.name).toBe("After Update");
    expect(updated.email).toBe("update@example.com");
  });

  it("should delete a user", async () => {
    const created = await createUserLogic({
      email: "delete@example.com",
      name: "Delete Me",
      password: "password",
    });

    const result = await deleteUserLogic(created.id);
    expect(result.success).toBe(true);

    await expect(getUserLogic(created.id)).rejects.toThrow("not found");
  });

  it("should throw on duplicate email", async () => {
    await createUserLogic({ email: "dup@example.com", name: "A", password: "pw" });
    await expect(
      createUserLogic({ email: "dup@example.com", name: "B", password: "pw" })
    ).rejects.toThrow();
  });

  it("should throw on missing fields", async () => {
    await expect(
      createUserLogic({ email: "", name: "X", password: "pw" })
    ).rejects.toThrow("required");
  });
});
