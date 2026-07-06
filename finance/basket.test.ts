import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";
import db from "../db/database";
import { financeAccount, financeAccountAccess, financeAccountType, financeBankcontact, financeBasketSnapshot, financeTransaction, financeTransactionSplit, users } from "../db/schema";
import { deleteBasketSnapshot, getTransactionSplits, listBasketSnapshots, loadBasketSnapshot, saveBasketSnapshot, setTransactionSplits } from "./basket";

const setAuth = (id: number) => vi.mocked(getAuthData).mockReturnValue({ userID: String(id), permissions: ["finance.view"] });

async function fixture() {
  await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (71,'basket@test.local','Basket','x')`);
  const [bank] = await db.insert(financeBankcontact).values({ name: "T", blz: "1", login: "u", server_url: "https://x" }).returning({ id: financeBankcontact.id });
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  const [account] = await db.insert(financeAccount).values({ bankcontact_id: bank.id, type_id: type.id, currency_code: "EUR", account_number: "BASKET", label: "Basket" }).returning({ id: financeAccount.id });
  await db.insert(financeAccountAccess).values({ account_id: account.id, user_id: 71, level: "write" });
  const [tx] = await db.insert(financeTransaction).values({ account_id: account.id, booking_date: "2026-01-01", amount: "-100.00", currency_code: "EUR", dedupe_hash: "basket-test-hash" }).returning({ id: financeTransaction.id });
  setAuth(71); return tx.id;
}

beforeEach(async () => {
  await db.delete(financeBasketSnapshot); await db.delete(financeTransactionSplit); await db.delete(financeTransaction);
  await db.delete(financeAccountAccess); await db.delete(financeAccount); await db.delete(financeBankcontact); await db.delete(users);
});

describe("finance basket persistence", () => {
  it("saves, loads, overwrites and deletes a named basket", async () => {
    const txId = await fixture();
    const saved = await saveBasketSnapshot({ name: "Q1", transaction_ids: [txId] });
    expect((await listBasketSnapshots()).items).toHaveLength(1);
    expect((await loadBasketSnapshot({ id: saved.id })).transaction_ids).toEqual([txId]);
    await saveBasketSnapshot({ name: "Q1", transaction_ids: [] });
    expect((await loadBasketSnapshot({ id: saved.id })).transaction_ids).toEqual([]);
    expect(await deleteBasketSnapshot({ id: saved.id })).toEqual({ deleted: true });
  });

  it("enforces an exact split sum", async () => {
    const txId = await fixture();
    await expect(setTransactionSplits({ transactionId: txId, splits: [{ amount: -40 }, { amount: -50 }] })).rejects.toThrow(/sum/);
    await setTransactionSplits({ transactionId: txId, splits: [{ amount: -40, tags: ["beruflich"] }, { amount: -60, tags: ["privat"] }] });
    const splits = (await getTransactionSplits({ transactionId: txId })).items;
    expect(splits.map(row => row.amount)).toEqual(expect.arrayContaining(["-40.00", "-60.00"]));
    expect(splits.find(row => row.amount === "-40.00")?.tags).toEqual(["beruflich"]);
  });
});
