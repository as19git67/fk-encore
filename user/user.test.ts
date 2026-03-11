import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import {
  createUserLogic,
  getUserLogic,
  listUsersLogic,
  updateUserLogic,
  deleteUserLogic,
} from "./user.logic";

// Clean up tables before each test
beforeEach(() => {
  db.exec(`DELETE FROM user_roles`);
  db.exec(`DELETE FROM users`);
  db.exec(`DELETE FROM roles`);
});

describe("User Service", () => {
  it("should create a user", () => {
    const user = createUserLogic({
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

  it("should get a user by ID", () => {
    const created = createUserLogic({
      email: "get@example.com",
      name: "Get User",
      password: "password",
    });

    const fetched = getUserLogic(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.email).toBe(created.email);
  });

  it("should list users", () => {
    createUserLogic({ email: "a@example.com", name: "A", password: "pw" });
    createUserLogic({ email: "b@example.com", name: "B", password: "pw" });

    const result = listUsersLogic();
    expect(result.users).toHaveLength(2);
  });

  it("should update a user", () => {
    const created = createUserLogic({
      email: "update@example.com",
      name: "Before Update",
      password: "password",
    });

    const updated = updateUserLogic({
      id: created.id,
      name: "After Update",
    });

    expect(updated.name).toBe("After Update");
    expect(updated.email).toBe("update@example.com");
  });

  it("should delete a user", () => {
    const created = createUserLogic({
      email: "delete@example.com",
      name: "Delete Me",
      password: "password",
    });

    const result = deleteUserLogic(created.id);
    expect(result.success).toBe(true);

    expect(() => getUserLogic(created.id)).toThrow("not found");
  });

  it("should throw on duplicate email", () => {
    createUserLogic({ email: "dup@example.com", name: "A", password: "pw" });
    expect(() =>
      createUserLogic({ email: "dup@example.com", name: "B", password: "pw" })
    ).toThrow();
  });

  it("should throw on missing fields", () => {
    expect(() =>
      createUserLogic({ email: "", name: "X", password: "pw" })
    ).toThrow("required");
  });
});
