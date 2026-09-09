// Accounts by invitation only.
//
// `POST /users` used to accept anyone who could reach the app. New accounts
// carried no roles, so it was never a way in — but it was an account
// factory, and it made every authenticated-but-unauthorized gap elsewhere
// anonymously reachable. These tests pin the gate that replaced it, and the
// two properties the gate rests on: an invite names one address, and it
// carries no roles.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";

import db from "../db/database";
import { users, sessions, userInvites, roles, userRoles } from "../db/schema";
import { createUser } from "./user";
import { createInvite, listInvites, revokeInvite, checkInvite } from "./invite";
import { createUserLogic } from "./user.service";
import {
  INVITE_TTL_MS,
  consumeInviteLogic,
  createInviteLogic,
  purgeStaleInvitesLogic,
} from "./invite.service";

const PASSWORD = "correct-horse";

let inviter: { id: number };

async function tokenFor(email: string): Promise<string> {
  const rows = await db.select().from(userInvites).where(eq(userInvites.email, email));
  return rows[0]!.token;
}

function signedInWith(permissions: string[], userID = String(inviter.id)) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions });
}

beforeEach(async () => {
  await db.delete(userInvites);
  await db.delete(userRoles);
  await db.delete(sessions);
  await db.delete(users);

  inviter = await createUserLogic({
    email: "admin@test.local",
    name: "Admin",
    password: PASSWORD,
  });
  signedInWith(["users.create"]);
});

describe("who may invite", () => {
  it("refuses a caller without users.create", async () => {
    signedInWith(["users.read", "users.list"]);
    await expect((createInvite as any)({ email: "new@test.local" })).rejects.toThrow(
      /users\.create/,
    );
    expect(await db.select().from(userInvites)).toHaveLength(0);
  });

  it("refuses to list invites without users.create", async () => {
    signedInWith([]);
    await expect((listInvites as any)({})).rejects.toThrow(/users\.create/);
  });

  it("refuses to revoke without users.create", async () => {
    await (createInvite as any)({ email: "new@test.local" });
    const [row] = await db.select().from(userInvites);
    signedInWith([]);
    await expect((revokeInvite as any)({ id: row!.id })).rejects.toThrow(/users\.create/);
  });

  it("never hands the token back to the inviter", async () => {
    // It goes to the invited mailbox and nowhere else, so holding
    // users.create is not the same as being able to register as somebody.
    const invite = await (createInvite as any)({ email: "new@test.local" });
    expect(JSON.stringify(invite)).not.toContain(await tokenFor("new@test.local"));
  });

  it("rejects an address that already has an account", async () => {
    await expect((createInvite as any)({ email: "admin@test.local" })).rejects.toThrow(
      /already exists/,
    );
  });

  it("rejects a malformed address", async () => {
    await expect((createInvite as any)({ email: "not-an-address" })).rejects.toThrow(
      /valid email/,
    );
  });

  it("normalizes the address so case cannot fork an account", async () => {
    await (createInvite as any)({ email: "  Mixed.Case@Test.Local " });
    const [row] = await db.select().from(userInvites);
    expect(row!.email).toBe("mixed.case@test.local");
  });

  it("replaces an invite still open for the same address", async () => {
    await (createInvite as any)({ email: "new@test.local" });
    const first = await tokenFor("new@test.local");
    await (createInvite as any)({ email: "new@test.local" });

    const rows = await db.select().from(userInvites).where(eq(userInvites.email, "new@test.local"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).not.toBe(first);
  });
});

describe("redeeming an invite", () => {
  beforeEach(async () => {
    await (createInvite as any)({ email: "new@test.local" });
  });

  it("creates the account for the invited address, not the one asked for", async () => {
    const invite = await tokenFor("new@test.local");
    const created = await (createUser as any)({ invite, name: "New", password: PASSWORD });
    expect(created.email).toBe("new@test.local");
  });

  it("gives the new account no roles", async () => {
    // The whole reason the inviter may not pre-assign: otherwise
    // users.create alone would be enough to mint an admin.
    const invite = await tokenFor("new@test.local");
    const created = await (createUser as any)({ invite, name: "New", password: PASSWORD });

    expect(created.roles).toHaveLength(0);
    const assigned = await db.select().from(userRoles).where(eq(userRoles.user_id, created.id));
    expect(assigned).toHaveLength(0);
  });

  it("refuses a request with no invite at all", async () => {
    await expect(
      (createUser as any)({ name: "Nobody", password: PASSWORD }),
    ).rejects.toThrow(/invitation is invalid/);
    expect(await db.select().from(users)).toHaveLength(1); // just the inviter
  });

  it("refuses an invented token", async () => {
    await expect(
      (createUser as any)({ invite: "made-up", name: "Nobody", password: PASSWORD }),
    ).rejects.toThrow(/invitation is invalid/);
  });

  it("accepts a token only once", async () => {
    const invite = await tokenFor("new@test.local");
    await (createUser as any)({ invite, name: "New", password: PASSWORD });

    await expect(
      (createUser as any)({ invite, name: "Again", password: PASSWORD }),
    ).rejects.toThrow(/invitation is invalid/);
    expect(await db.select().from(users)).toHaveLength(2);
  });

  it("refuses an expired token", async () => {
    const invite = await tokenFor("new@test.local");
    await db
      .update(userInvites)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(userInvites.token, invite));

    await expect(
      (createUser as any)({ invite, name: "Late", password: PASSWORD }),
    ).rejects.toThrow(/invitation is invalid/);
  });

  it("refuses a revoked token", async () => {
    const invite = await tokenFor("new@test.local");
    const [row] = await db.select().from(userInvites);
    await (revokeInvite as any)({ id: row!.id });

    await expect(
      (createUser as any)({ invite, name: "Gone", password: PASSWORD }),
    ).rejects.toThrow(/invitation is invalid/);
  });

  it("requires a name", async () => {
    const invite = await tokenFor("new@test.local");
    await expect(
      (createUser as any)({ invite, name: "   ", password: PASSWORD }),
    ).rejects.toThrow(/name is required/);
  });

  it("does not report why a token failed", async () => {
    // Unknown, spent and expired must be indistinguishable from outside.
    const spent = await tokenFor("new@test.local");
    await (createUser as any)({ invite: spent, name: "New", password: PASSWORD });

    const messages: string[] = [];
    for (const token of [spent, "never-existed"]) {
      await (createUser as any)({ invite: token, name: "X", password: PASSWORD }).catch(
        (err: Error) => messages.push(err.message),
      );
    }
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
  });
});

describe("checking an invite before registering", () => {
  it("names the address the token was issued for", async () => {
    await (createInvite as any)({ email: "new@test.local" });
    const token = await tokenFor("new@test.local");
    expect(await (checkInvite as any)({ token })).toEqual({ email: "new@test.local" });
  });

  it("does not consume the token", async () => {
    await (createInvite as any)({ email: "new@test.local" });
    const token = await tokenFor("new@test.local");
    await (checkInvite as any)({ token });

    const created = await (createUser as any)({ invite: token, name: "New", password: PASSWORD });
    expect(created.email).toBe("new@test.local");
  });

  it("reports a dead token as not found", async () => {
    await expect((checkInvite as any)({ token: "nope" })).rejects.toThrow(
      /invalid, already used, or expired/,
    );
  });
});

describe("the invite list", () => {
  it("shows open invites and hides ones that expired long ago", async () => {
    await (createInvite as any)({ email: "open@test.local" });
    await (createInvite as any)({ email: "stale@test.local" });
    await db
      .update(userInvites)
      .set({ expires_at: new Date(Date.now() - 2 * INVITE_TTL_MS).toISOString() })
      .where(eq(userInvites.email, "stale@test.local"));

    const { invites } = await (listInvites as any)({});
    expect(invites.map((i: any) => i.email)).toEqual(["open@test.local"]);
  });

  it("keeps showing an invite that was just redeemed", async () => {
    await (createInvite as any)({ email: "new@test.local" });
    const invite = await tokenFor("new@test.local");
    await (createUser as any)({ invite, name: "New", password: PASSWORD });

    const { invites } = await (listInvites as any)({});
    expect(invites).toHaveLength(1);
    expect(invites[0].accepted_at).not.toBeNull();
  });

  it("records who sent the invite", async () => {
    await (createInvite as any)({ email: "new@test.local" });
    const { invites } = await (listInvites as any)({});
    expect(invites[0].invited_by_user_id).toBe(inviter.id);
  });

  it("refuses to revoke one that has been accepted", async () => {
    await (createInvite as any)({ email: "new@test.local" });
    const invite = await tokenFor("new@test.local");
    await (createUser as any)({ invite, name: "New", password: PASSWORD });

    const [row] = await db.select().from(userInvites);
    await expect((revokeInvite as any)({ id: row!.id })).rejects.toThrow(/already been accepted/);
  });
});

describe("housekeeping", () => {
  it("purges long-expired unused invites but keeps accepted ones", async () => {
    await (createInvite as any)({ email: "stale@test.local" });
    await (createInvite as any)({ email: "used@test.local" });
    const used = await tokenFor("used@test.local");
    await consumeInviteLogic(used);

    const longAgo = new Date(Date.now() - 2 * INVITE_TTL_MS).toISOString();
    await db.update(userInvites).set({ expires_at: longAgo });

    await purgeStaleInvitesLogic();

    const left = await db.select().from(userInvites);
    expect(left.map((r) => r.email)).toEqual(["used@test.local"]);
  });
});

describe("the inviter's own permission", () => {
  it("is the one that was previously never checked anywhere", async () => {
    // users.create existed in the catalogue all along with no enforcement,
    // because registration was open. Pin that it now gates something.
    const seeded = await db.select().from(roles);
    expect(Array.isArray(seeded)).toBe(true);

    signedInWith(["users.read"]);
    await expect((createInvite as any)({ email: "new@test.local" })).rejects.toThrow(
      /users\.create/,
    );

    signedInWith(["users.create"]);
    await expect((createInvite as any)({ email: "new@test.local" })).resolves.toBeTruthy();
  });
});

describe("createInviteLogic directly", () => {
  it("stores a distinct high-entropy token per invite", async () => {
    await createInviteLogic(inviter.id, "one@test.local");
    await createInviteLogic(inviter.id, "two@test.local");
    const rows = await db.select().from(userInvites);
    const tokens = rows.map((r) => r.token);
    expect(new Set(tokens).size).toBe(2);
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(40);
  });
});
