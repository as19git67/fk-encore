import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeBankcontact,
  financeTag,
  financeTagTransaction,
  financeTransaction,
  users,
} from "../db/schema";
import { removeAiTagsWhereUserTagged } from "./tag-cleanup-cron";

beforeEach(async () => {
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeTag);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
});

async function createAccount(): Promise<number> {
  const [bc] = await db
    .insert(financeBankcontact)
    .values({ name: "T", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  const [type] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .limit(1);
  const [a] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bc.id,
      type_id: type.id,
      currency_code: "EUR",
      account_number: "A",
      label: "Giro",
    })
    .returning({ id: financeAccount.id });
  return a.id;
}

async function insertTx(accountId: number): Promise<number> {
  const [row] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: "2024-08-15",
      amount: "42.00",
      currency_code: "EUR",
      dedupe_hash: `h-${Math.random()}`,
      purpose: "Test",
      counterparty: "TestShop",
    })
    .returning({ id: financeTransaction.id });
  return row.id;
}

async function insertTag(
  name: string,
  source: "user" | "ai",
): Promise<number> {
  const [row] = await db
    .insert(financeTag)
    .values({ name, source })
    .returning({ id: financeTag.id });
  return row.id;
}

async function linkTag(tagId: number, txId: number): Promise<void> {
  await db
    .insert(financeTagTransaction)
    .values({ tag_id: tagId, transaction_id: txId });
}

async function tagJoinsFor(txId: number) {
  return db
    .select({ name: financeTag.name, source: financeTag.source })
    .from(financeTagTransaction)
    .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
    .where(eq(financeTagTransaction.transaction_id, txId));
}

describe("removeAiTagsWhereUserTagged", () => {
  it("removes AI tags when user tags exist on same transaction", async () => {
    const acc = await createAccount();
    const tx = await insertTx(acc);

    const userTagId = await insertTag("miete", "user");
    const aiTagId = await insertTag("wohnen", "ai");
    await linkTag(userTagId, tx);
    await linkTag(aiTagId, tx);

    const deleted = await removeAiTagsWhereUserTagged();
    expect(deleted).toBe(1);

    const remaining = await tagJoinsFor(tx);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source).toBe("user");
    expect(remaining[0].name).toBe("miete");
  });

  it("leaves AI tags untouched when no user tags exist", async () => {
    const acc = await createAccount();
    const tx = await insertTx(acc);

    const aiTagId = await insertTag("auto", "ai");
    await linkTag(aiTagId, tx);

    const deleted = await removeAiTagsWhereUserTagged();
    expect(deleted).toBe(0);

    const remaining = await tagJoinsFor(tx);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source).toBe("ai");
  });

  it("leaves user tags on other transactions untouched", async () => {
    const acc = await createAccount();
    const tx1 = await insertTx(acc);
    const tx2 = await insertTx(acc);

    const userTagId = await insertTag("miete", "user");
    const aiTagId = await insertTag("wohnen", "ai");

    // tx1: user + ai → ai should be removed
    await linkTag(userTagId, tx1);
    await linkTag(aiTagId, tx1);

    // tx2: only ai → should remain
    await linkTag(aiTagId, tx2);

    const deleted = await removeAiTagsWhereUserTagged();
    expect(deleted).toBe(1);

    const remaining1 = await tagJoinsFor(tx1);
    expect(remaining1).toHaveLength(1);
    expect(remaining1[0].source).toBe("user");

    const remaining2 = await tagJoinsFor(tx2);
    expect(remaining2).toHaveLength(1);
    expect(remaining2[0].source).toBe("ai");
  });

  it("handles multiple AI tags on a single transaction", async () => {
    const acc = await createAccount();
    const tx = await insertTx(acc);

    const userTagId = await insertTag("gehalt", "user");
    const aiTag1 = await insertTag("einkommen", "ai");
    const aiTag2 = await insertTag("arbeit", "ai");
    await linkTag(userTagId, tx);
    await linkTag(aiTag1, tx);
    await linkTag(aiTag2, tx);

    const deleted = await removeAiTagsWhereUserTagged();
    expect(deleted).toBe(2);

    const remaining = await tagJoinsFor(tx);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("gehalt");
  });

  it("returns 0 when there is nothing to clean up", async () => {
    const deleted = await removeAiTagsWhereUserTagged();
    expect(deleted).toBe(0);
  });
});
