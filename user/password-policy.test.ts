// Every path that sets a user-chosen password takes the same floor. Before
// this, registration and change-password checked nothing at all and only the
// reset path had a rule, so the effective policy depended on which door you
// came through.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { currentRequest } from "encore.dev";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { users, sessions, passwordResetTokens, userInvites } from "../db/schema";
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from "./password-policy";
import { createUser, updateUser, changePassword } from "./user";
import { createUserLogic } from "./user.service";
import { createInviteLogic } from "./invite.service";
import { resetPasswordLogic } from "./auth.service";
import { __resetRateLimiterForTests } from "./rateLimiter";

const TOO_SHORT = "a".repeat(MIN_PASSWORD_LENGTH - 1);
const LONG_ENOUGH = "a".repeat(MIN_PASSWORD_LENGTH);

beforeEach(async () => {
  __resetRateLimiterForTests();
  await db.delete(passwordResetTokens);
  await db.delete(userInvites);
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
  async function inviteFor(email: string): Promise<string> {
    const inviter = await createUserLogic({
      email: `inviter-${email}`,
      name: "Inviter",
      password: LONG_ENOUGH,
    });
    await createInviteLogic(inviter.id, email);
    const rows = await db.select().from(userInvites).where(eq(userInvites.email, email));
    return rows[0]!.token;
  }

  it("refuses a password below the policy", async () => {
    const invite = await inviteFor("a@test.local");

    await expect(
      (createUser as any)({ invite, name: "A", password: TOO_SHORT }),
    ).rejects.toThrow(/at least/);

    const rows = await db.select().from(users).where(eq(users.email, "a@test.local"));
    expect(rows).toHaveLength(0);
  });

  it("does not spend the invite on a password the policy rejects", async () => {
    // The order matters: a fumbled password must not cost somebody their
    // one-time link.
    const invite = await inviteFor("a2@test.local");

    await expect(
      (createUser as any)({ invite, name: "A", password: TOO_SHORT }),
    ).rejects.toThrow(/at least/);

    const created = await (createUser as any)({ invite, name: "A", password: LONG_ENOUGH });
    expect(created.email).toBe("a2@test.local");
  });

  it("accepts one that meets it", async () => {
    const invite = await inviteFor("b@test.local");

    const created = await (createUser as any)({ invite, name: "B", password: LONG_ENOUGH });
    expect(created.email).toBe("b@test.local");
    // New accounts carry no roles — an invite is not a privilege path.
    expect(created.roles).toHaveLength(0);
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
