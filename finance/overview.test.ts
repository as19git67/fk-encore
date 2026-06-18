import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { and, eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeBankcontact,
  financeTag,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  financeUserPref,
  users,
} from "../db/schema";
import { getOverview, saveOverview } from "./overview";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number, email = `u${id}@test.local`): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${email}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeTag);
  await db.delete(financeAccountBalance);
  await db.delete(financeTanSession);
  await db.delete(financeAccountAccess);
  await db.delete(financeUserPref);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  setAuth("1", []);
});

async function typeIdFor(kind: string): Promise<number> {
  const [row] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .where(eq(financeAccountType.kind, kind as any))
    .limit(1);
  return row.id;
}

async function insertAccount(
  label: string,
  kind = "giro",
): Promise<number> {
  const typeId = await typeIdFor(kind);
  const [row] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: null,
      type_id: typeId,
      currency_code: "EUR",
      account_number: `AN-${label}`,
      label,
    })
    .returning({ id: financeAccount.id });
  return row.id;
}

async function grantAcl(accountId: number, userId: number, level: "read" | "write" = "read") {
  await ensureUser(userId);
  await db.insert(financeAccountAccess).values({
    account_id: accountId,
    user_id: userId,
    level,
  });
}

async function insertBalance(
  accountId: number,
  balance: string,
  asOf: string,
  currency: string = "EUR",
) {
  await db.insert(financeAccountBalance).values({
    account_id: accountId,
    as_of: asOf,
    balance,
    source: "manual",
    currency_code: currency,
  });
}

async function insertTransaction(
  accountId: number,
  bookingDate: string,
  dedupeSuffix: string,
  amount = "-12.34",
): Promise<number> {
  const [row] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: bookingDate,
      amount,
      currency_code: "EUR",
      dedupe_hash: dedupeSuffix.padEnd(64, "0"),
    })
    .returning({ id: financeTransaction.id });
  return row.id;
}

async function tagTransaction(
  txId: number,
  tagName: string,
  source: "user" | "ai" = "user",
) {
  let [tag] = await db
    .select({ id: financeTag.id })
    .from(financeTag)
    .where(and(eq(financeTag.name, tagName), eq(financeTag.source, source)))
    .limit(1);
  if (!tag) {
    [tag] = await db
      .insert(financeTag)
      .values({ name: tagName, source })
      .returning({ id: financeTag.id });
  }
  await db.insert(financeTagTransaction).values({
    tag_id: tag.id,
    transaction_id: txId,
  });
}

describe("finance/overview — defaults", () => {
  it("synthesises Täglich/Sparen sections from account types when no config is saved", async () => {
    const giro = await insertAccount("Anton Giro", "giro");
    const visa = await insertAccount("Anton Visa", "kreditkarte");
    const tagesgeld = await insertAccount("Anton Tagesgeld", "tagesgeld");
    const depot = await insertAccount("Anton Depot", "depot");

    await ensureUser(7, "anton@schegg.de");
    await grantAcl(giro, 7);
    await grantAcl(visa, 7);
    await grantAcl(tagesgeld, 7);
    await grantAcl(depot, 7);

    setAuth("7", ["finance.view"]);
    const resp = await getOverview();

    expect(resp.is_default).toBe(true);
    expect(resp.user_email).toBe("anton@schegg.de");

    const taeglich = resp.sections.find((s) => s.name === "Täglich");
    const sparen = resp.sections.find((s) => s.name === "Sparen");
    expect(taeglich?.accounts.map((a) => a.label).sort()).toEqual(
      ["Anton Giro", "Anton Visa"],
    );
    expect(sparen?.accounts.map((a) => a.label).sort()).toEqual(
      ["Anton Depot", "Anton Tagesgeld"],
    );
    expect(resp.unassigned).toEqual([]);
  });

  it("returns balance + as_of for the latest finance_account_balance row", async () => {
    const giro = await insertAccount("Anton Giro", "giro");
    await ensureUser(7);
    await grantAcl(giro, 7);

    await insertBalance(giro, "100.00", "2026-04-01T00:00:00Z");
    await insertBalance(giro, "1234.56", "2026-04-15T08:30:00Z");
    await insertBalance(giro, "999.99", "2026-04-10T00:00:00Z");

    setAuth("7", ["finance.view"]);
    const resp = await getOverview();
    const acc = resp.sections.flatMap((s) => s.accounts).find((a) => a.id === giro);
    expect(acc?.balance).toBe("1234.56");
    expect(acc?.balance_as_of?.startsWith("2026-04-15")).toBe(true);
  });

  it("counts only recent transactions without user tags as pending", async () => {
    const giro = await insertAccount("Anton Giro", "giro");
    await ensureUser(7);
    await grantAcl(giro, 7);

    const today = new Date();
    const recent = today.toISOString().slice(0, 10);
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

    const t1 = await insertTransaction(giro, recent, "a"); // pending
    const t2 = await insertTransaction(giro, recent, "b"); // pending
    const t3 = await insertTransaction(giro, recent, "c"); // user-tagged → not pending
    await insertTransaction(giro, old, "d");               // out of window

    await tagTransaction(t3, "Lebensmittel", "user");
    // AI tag alone must not count as "tagged" — still pending.
    await tagTransaction(t1, "Auto", "ai");
    void t2;

    setAuth("7", ["finance.view"]);
    const resp = await getOverview();
    const acc = resp.sections.flatMap((s) => s.accounts).find((a) => a.id === giro);
    expect(acc?.pending_count).toBe(2);
  });

  it("filters accounts through the per-user ACL", async () => {
    const mine = await insertAccount("Mine", "giro");
    const theirs = await insertAccount("Theirs", "giro");
    await ensureUser(7);
    await grantAcl(mine, 7);

    setAuth("7", ["finance.view"]);
    const resp = await getOverview();
    const labels = resp.sections.flatMap((s) => s.accounts.map((a) => a.label));
    expect(labels).toContain("Mine");
    expect(labels).not.toContain("Theirs");
  });

  it("admins bypass the ACL and see every account", async () => {
    await insertAccount("A", "giro");
    await insertAccount("B", "tagesgeld");
    await ensureUser(1);

    setAuth("1", ["finance.view", "finance.admin"]);
    const resp = await getOverview();
    const labels = resp.sections.flatMap((s) => s.accounts.map((a) => a.label));
    expect(labels.sort()).toEqual(["A", "B"]);
  });

  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(getOverview()).rejects.toThrow(/permission/);
  });
});

describe("finance/overview — saved config", () => {
  it("returns saved sections in user-defined order, dropping accounts the user no longer has access to", async () => {
    const a1 = await insertAccount("A1", "giro");
    const a2 = await insertAccount("A2", "tagesgeld");
    const stale = await insertAccount("Stale", "giro");
    await ensureUser(7);
    await grantAcl(a1, 7);
    await grantAcl(a2, 7);
    // No ACL for `stale` — but it appears in the saved config.

    await db.insert(financeUserPref).values({
      user_id: 7,
      key: "overview",
      value: {
        sections: [
          { name: "Wichtig", account_ids: [a1, stale] },
          { name: "Rest", account_ids: [a2] },
        ],
      },
    });

    setAuth("7", ["finance.view"]);
    const resp = await getOverview();
    expect(resp.is_default).toBe(false);
    expect(resp.sections.map((s) => s.name)).toEqual(["Wichtig", "Rest"]);
    expect(resp.sections[0].accounts.map((a) => a.id)).toEqual([a1]);
    expect(resp.sections[1].accounts.map((a) => a.id)).toEqual([a2]);
    expect(resp.unassigned).toEqual([]);
  });

  it("surfaces accessible accounts not placed in any saved section as unassigned", async () => {
    const placed = await insertAccount("Placed", "giro");
    const free = await insertAccount("Free", "giro");
    await ensureUser(7);
    await grantAcl(placed, 7);
    await grantAcl(free, 7);

    await db.insert(financeUserPref).values({
      user_id: 7,
      key: "overview",
      value: { sections: [{ name: "Nur Eines", account_ids: [placed] }] },
    });

    setAuth("7", ["finance.view"]);
    const resp = await getOverview();
    expect(resp.sections[0].accounts.map((a) => a.id)).toEqual([placed]);
    expect(resp.unassigned.map((a) => a.id)).toEqual([free]);
  });
});

describe("finance/overview — saveOverview", () => {
  it("persists a fresh config", async () => {
    const a1 = await insertAccount("A1", "giro");
    const a2 = await insertAccount("A2", "tagesgeld");
    await ensureUser(7);
    await grantAcl(a1, 7);
    await grantAcl(a2, 7);

    setAuth("7", ["finance.view"]);
    const result = await saveOverview({
      sections: [
        { name: "Täglich", account_ids: [a1] },
        { name: "Sparen", account_ids: [a2] },
      ],
    });
    expect(result).toMatchObject({
      saved: true,
      sections_saved: 2,
      accounts_saved: 2,
    });

    const [row] = await db
      .select()
      .from(financeUserPref)
      .where(and(eq(financeUserPref.user_id, 7), eq(financeUserPref.key, "overview")));
    expect(row).toBeDefined();
    const value = row.value as { sections: Array<{ name: string; account_ids: number[] }> };
    expect(value.sections).toEqual([
      { name: "Täglich", account_ids: [a1] },
      { name: "Sparen", account_ids: [a2] },
    ]);
  });

  it("overwrites an existing config on a second call", async () => {
    const a1 = await insertAccount("A1", "giro");
    await ensureUser(7);
    await grantAcl(a1, 7);

    setAuth("7", ["finance.view"]);
    await saveOverview({ sections: [{ name: "Erst", account_ids: [a1] }] });
    await saveOverview({ sections: [{ name: "Zweit", account_ids: [a1] }] });

    const resp = await getOverview();
    expect(resp.sections.map((s) => s.name)).toEqual(["Zweit"]);
  });

  it("rejects an account the caller can't access", async () => {
    const mine = await insertAccount("Mine", "giro");
    const theirs = await insertAccount("Theirs", "giro");
    await ensureUser(7);
    await grantAcl(mine, 7);

    setAuth("7", ["finance.view"]);
    await expect(
      saveOverview({
        sections: [{ name: "Liste", account_ids: [mine, theirs] }],
      }),
    ).rejects.toThrow(/no access/);
  });

  it("rejects duplicate account ids across sections", async () => {
    const a1 = await insertAccount("A1", "giro");
    await ensureUser(7);
    await grantAcl(a1, 7);

    setAuth("7", ["finance.view"]);
    await expect(
      saveOverview({
        sections: [
          { name: "Erst", account_ids: [a1] },
          { name: "Zweit", account_ids: [a1] },
        ],
      }),
    ).rejects.toThrow(/more than one section/);
  });

  it("rejects duplicate section names", async () => {
    setAuth("7", ["finance.view"]);
    await expect(
      saveOverview({
        sections: [
          { name: "Gleich", account_ids: [] },
          { name: "Gleich", account_ids: [] },
        ],
      }),
    ).rejects.toThrow(/duplicate section name/);
  });

  it("rejects empty section names", async () => {
    setAuth("7", ["finance.view"]);
    await expect(
      saveOverview({ sections: [{ name: "   ", account_ids: [] }] }),
    ).rejects.toThrow(/section name required/);
  });

  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(saveOverview({ sections: [] })).rejects.toThrow(/permission/);
  });
});
