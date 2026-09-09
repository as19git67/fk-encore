// Every path that sets a user-chosen password takes the same floor. Before
// this, registration and change-password checked nothing at all and only the
// reset path had a rule, so the effective policy depended on which door you
// came through.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { currentRequest } from "encore.dev";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { users, sessions, passwordResetTokens } from "../db/schema";
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from "./password-policy";
import { createUser, updateUser, changePassword } from "./user";
import { createUserLogic } from "./user.service";
import { resetPasswordLogic } from "./auth.service";
import { __resetRateLimiterForTests } from "./rateLimiter";

const TOO_SHORT = "a".repeat(MIN_PASSWORD_LENGTH - 1);
const LONG_ENOUGH = "a".repeat(MIN_PASSWORD_LENGTH);

beforeEach(async () => {
  __resetRateLimiterForTests();
  await db.delete(passwordResetTokens);
  await db.delete(sessions);
  await db.delete(users);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(currentRequest).mockReturnValue({
    type: "api-call",
    headers: {},
  } as never);
});

describe("passwordPolicyError", () => {
  it("rejects anything shorter than the minimum", () => {
    expect(passwordPolicyError(TOO_SHORT)).toMatch(/at least/);
  });

  it("accepts a password at exactly the minimum", () => {
    expect(passwordPolicyError(LONG_ENOUGH)).toBeNull();
  });

  it("rejects an empty or missing password", () => {
    expect(passwordPolicyError("")).toMatch(/at least/);
    expect(passwordPolicyError(undefined)).toMatch(/at least/);
  });
});

describe("registration", () => {
  it("refuses a password below the policy", async () => {
    await expect(
      (createUser as any)({ email: "a@test.local", name: "A", password: TOO_SHORT }),
    ).rejects.toThrow(/at least/);

    const rows = await db.select().from(users).where(eq(users.email, "a@test.local"));
    expect(rows).toHaveLength(0);
  });

  it("accepts one that meets it", async () => {
    const created = await (createUser as any)({
      email: "b@test.local",
      name: "B",
      password: LONG_ENOUGH,
    });
    expect(created.email).toBe("b@test.local");
    // New accounts carry no roles — registration is not a privilege path.
    expect(created.roles).toHaveLength(0);
  });

  it("caps registrations per address once the proxy headers are trusted", async () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.mocked(currentRequest).mockReturnValue({
      type: "api-call",
      headers: { "x-forwarded-for": "203.0.113.5" },
    } as never);

    for (let i = 0; i < 5; i++) {
      await (createUser as any)({
        email: `bulk${i}@test.local`,
        name: "Bulk",
        password: LONG_ENOUGH,
      });
    }

    await expect(
      (createUser as any)({ email: "bulk5@test.local", name: "Bulk", password: LONG_ENOUGH }),
    ).rejects.toThrow(/Too many accounts/);
  });

  it("does not cap when there is no trustworthy address", async () => {
    // The headers are ignored by default, so there is no key to limit on and
    // the ceiling must not fall back to a shared bucket.
    vi.mocked(currentRequest).mockReturnValue({
      type: "api-call",
      headers: { "x-forwarded-for": "203.0.113.5" },
    } as never);

    for (let i = 0; i < 8; i++) {
      await (createUser as any)({
        email: `nolimit${i}@test.local`,
        name: "N",
        password: LONG_ENOUGH,
      });
    }

    const rows = await db.select().from(users);
    expect(rows.length).toBeGreaterThanOrEqual(8);
  });
});

describe("change password", () => {
  beforeEach(() => {
    vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: [] });
  });

  it("refuses a new password below the policy", async () => {
    const user = await createUserLogic({
      email: "c@test.local",
      name: "C",
      password: LONG_ENOUGH,
    });
    vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: [] });

    await expect(
      (changePassword as any)({ current_password: LONG_ENOUGH, new_password: TOO_SHORT }),
    ).rejects.toThrow(/at least/);
  });

  it("checks the policy before the current password, so neither leaks the other", async () => {
    const user = await createUserLogic({
      email: "d@test.local",
      name: "D",
      password: LONG_ENOUGH,
    });
    vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: [] });

    await expect(
      (changePassword as any)({ current_password: "wrong-entirely", new_password: TOO_SHORT }),
    ).rejects.toThrow(/at least/);
  });
});

describe("admin user update", () => {
  beforeEach(() => {
    vi.mocked(getAuthData).mockReturnValue({
      userID: "1",
      permissions: ["users.update"],
    });
  });

  it("refuses to set somebody's password below the policy", async () => {
    const user = await createUserLogic({
      email: "e@test.local",
      name: "E",
      password: LONG_ENOUGH,
    });

    await expect(
      (updateUser as any)({ id: user.id, password: TOO_SHORT }),
    ).rejects.toThrow(/at least/);
  });

  it("still allows an update that does not touch the password", async () => {
    const user = await createUserLogic({
      email: "f@test.local",
      name: "F",
      password: LONG_ENOUGH,
    });

    const updated = await (updateUser as any)({ id: user.id, name: "F renamed" });
    expect(updated.name).toBe("F renamed");
  });
});

describe("password reset", () => {
  it("uses the same floor as the other paths", async () => {
    await expect(
      resetPasswordLogic({ token: "irrelevant", new_password: TOO_SHORT }),
    ).rejects.toThrow(/at least/);
  });
});
