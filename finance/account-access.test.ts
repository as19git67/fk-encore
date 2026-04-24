import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeBankcontact,
  users,
} from "../db/schema";
import {
  listAccountAccess,
  putAccountAccess,
} from "./account-access";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  setAuth("1", []);
});

async function createScenario(): Promise<{ accountId: number }> {
  const [bc] = await db
    .insert(financeBankcontact)
    .values({
      name: "Test",
      blz: "1",
      login: "u",
      server_url: "https://x",
    })
    .returning({ id: financeBankcontact.id });
  const [type] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .limit(1);
  const [acc] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bc.id,
      type_id: type.id,
      currency_code: "EUR",
      account_number: "1",
      label: "Giro",
    })
    .returning({ id: financeAccount.id });
  return { accountId: acc.id };
}

// -------- Permissions --------

describe("finance/account-access — permissions", () => {
  it("GET requires finance.admin", async () => {
    const { accountId } = await createScenario();
    setAuth("1", ["finance.accounts.manage"]);
    await expect(listAccountAccess({ accountId })).rejects.toThrow(
      /permission/,
    );
  });

  it("PUT requires finance.admin", async () => {
    const { accountId } = await createScenario();
    setAuth("1", ["finance.accounts.manage"]);
    await expect(
      putAccountAccess({ accountId, entries: [] }),
    ).rejects.toThrow(/permission/);
  });
});

// -------- GET --------

describe("finance/account-access — list", () => {
  it("returns users with email/name joined in", async () => {
    const { accountId } = await createScenario();
    await ensureUser(5);
    await ensureUser(6);
    await db.insert(financeAccountAccess).values([
      { account_id: accountId, user_id: 5, level: "read" },
      { account_id: accountId, user_id: 6, level: "write" },
    ]);

    setAuth("1", ["finance.admin"]);
    const { items } = await listAccountAccess({ accountId });
    expect(items).toHaveLength(2);
    const byId = new Map(items.map((i) => [i.user_id, i]));
    expect(byId.get(5)?.user_email).toBe("u5@test.local");
    expect(byId.get(5)?.level).toBe("read");
    expect(byId.get(6)?.level).toBe("write");
  });

  it("404s when the account does not exist", async () => {
    setAuth("1", ["finance.admin"]);
    await expect(
      listAccountAccess({ accountId: 999_999 }),
    ).rejects.toThrow(/not found/);
  });
});

// -------- PUT diff semantics --------

describe("finance/account-access — put (diff save)", () => {
  it("inserts new entries and reports correct counters", async () => {
    const { accountId } = await createScenario();
    await ensureUser(5);
    await ensureUser(6);

    setAuth("1", ["finance.admin"]);
    const result = await putAccountAccess({
      accountId,
      entries: [
        { user_id: 5, level: "read" },
        { user_id: 6, level: "write" },
      ],
    });

    expect(result.diff).toEqual({ inserted: 2, updated: 0, deleted: 0 });
    expect(result.items).toHaveLength(2);
  });

  it("computes a precise diff (insert C, update A, delete B)", async () => {
    const { accountId } = await createScenario();
    await ensureUser(5);
    await ensureUser(6);
    await ensureUser(7);
    await db.insert(financeAccountAccess).values([
      { account_id: accountId, user_id: 5, level: "read" },
      { account_id: accountId, user_id: 6, level: "write" },
    ]);

    setAuth("1", ["finance.admin"]);
    const result = await putAccountAccess({
      accountId,
      entries: [
        { user_id: 5, level: "write" }, // updated
        { user_id: 7, level: "read" }, // inserted
      ],
    });

    expect(result.diff).toEqual({ inserted: 1, updated: 1, deleted: 1 });
    const rows = await db
      .select()
      .from(financeAccountAccess)
      .where(eq(financeAccountAccess.account_id, accountId));
    const byUser = new Map(rows.map((r) => [r.user_id, r.level]));
    expect(byUser.get(5)).toBe("write");
    expect(byUser.get(6)).toBeUndefined();
    expect(byUser.get(7)).toBe("read");
  });

  it("is idempotent when called with the same list (zero diff)", async () => {
    const { accountId } = await createScenario();
    await ensureUser(5);
    await db.insert(financeAccountAccess).values({
      account_id: accountId,
      user_id: 5,
      level: "read",
    });

    setAuth("1", ["finance.admin"]);
    const result = await putAccountAccess({
      accountId,
      entries: [{ user_id: 5, level: "read" }],
    });
    expect(result.diff).toEqual({ inserted: 0, updated: 0, deleted: 0 });
  });

  it("empty entries list removes all ACLs", async () => {
    const { accountId } = await createScenario();
    await ensureUser(5);
    await ensureUser(6);
    await db.insert(financeAccountAccess).values([
      { account_id: accountId, user_id: 5, level: "read" },
      { account_id: accountId, user_id: 6, level: "write" },
    ]);

    setAuth("1", ["finance.admin"]);
    const result = await putAccountAccess({ accountId, entries: [] });
    expect(result.diff).toEqual({ inserted: 0, updated: 0, deleted: 2 });
    expect(result.items).toHaveLength(0);
  });
});

describe("finance/account-access — put validation", () => {
  it("rejects duplicate user_id in entries", async () => {
    const { accountId } = await createScenario();
    await ensureUser(5);
    setAuth("1", ["finance.admin"]);
    await expect(
      putAccountAccess({
        accountId,
        entries: [
          { user_id: 5, level: "read" },
          { user_id: 5, level: "write" },
        ],
      }),
    ).rejects.toThrow(/duplicate/);
  });

  it("rejects invalid level", async () => {
    const { accountId } = await createScenario();
    await ensureUser(5);
    setAuth("1", ["finance.admin"]);
    await expect(
      putAccountAccess({
        accountId,
        entries: [{ user_id: 5, level: "owner" as any }],
      }),
    ).rejects.toThrow(/level/);
  });

  it("rejects unknown user_id", async () => {
    const { accountId } = await createScenario();
    setAuth("1", ["finance.admin"]);
    await expect(
      putAccountAccess({
        accountId,
        entries: [{ user_id: 999_999, level: "read" }],
      }),
    ).rejects.toThrow(/user 999999/);
  });
});
