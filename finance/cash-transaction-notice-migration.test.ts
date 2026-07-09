import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  documents,
  financeAccount,
  financeAccountType,
  financeBankcontact,
  financeTransaction,
  users,
} from "../db/schema";

// Re-executes the actual migration SQL (already applied once, no-op-safe,
// against a fresh table) so the test tracks the real file rather than a
// re-typed copy of its logic.
const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, "..", "db", "migrations", "postgres", "0121_fix_cash_transaction_notice_purpose_bug.sql"),
  "utf8",
);

const USER_ID = 992101;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function ensureCashAccount(): Promise<number> {
  const [type] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .where(eq(financeAccountType.kind, "bargeld"))
    .limit(1);
  const [account] = await db
    .insert(financeAccount)
    .values({
      type_id: type.id,
      currency_code: "EUR",
      account_number: `cash-${Math.random()}`,
      label: "Portemonnaie",
    })
    .returning({ id: financeAccount.id });
  return account.id;
}

async function ensureGiroAccount(): Promise<number> {
  const [bc] = await db
    .insert(financeBankcontact)
    .values({ name: "T", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  const [type] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .where(eq(financeAccountType.kind, "giro"))
    .limit(1);
  const [account] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bc.id,
      type_id: type.id,
      currency_code: "EUR",
      account_number: `giro-${Math.random()}`,
      label: "Giro",
    })
    .returning({ id: financeAccount.id });
  return account.id;
}

async function insertTx(
  accountId: number,
  purpose: string | null,
  notice: string | null,
): Promise<number> {
  const [row] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: "2024-08-15",
      amount: "-12.00",
      currency_code: "EUR",
      purpose,
      notice,
      dedupe_hash: `hash-${accountId}-${Math.random()}`,
    })
    .returning({ id: financeTransaction.id });
  return row.id;
}

beforeEach(async () => {
  await db.delete(documents);
  await db.delete(financeTransaction);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await ensureUser(USER_ID);
});

describe("migration 0121 — cash transaction notice/purpose data fix", () => {
  it("moves a bare purpose into notice and clears purpose", async () => {
    const cash = await ensureCashAccount();
    const txId = await insertTx(cash, "War mit Anna einkaufen", null);

    await db.execute(sql.raw(MIGRATION_SQL));

    const [row] = await db
      .select({ purpose: financeTransaction.purpose, notice: financeTransaction.notice })
      .from(financeTransaction)
      .where(eq(financeTransaction.id, txId));
    expect(row.purpose).toBeNull();
    expect(row.notice).toBe("War mit Anna einkaufen");
  });

  it("prepends the misplaced purpose in front of an existing notice", async () => {
    const cash = await ensureCashAccount();
    const txId = await insertTx(cash, "War mit Anna einkaufen", "Bar bezahlt");

    await db.execute(sql.raw(MIGRATION_SQL));

    const [row] = await db
      .select({ purpose: financeTransaction.purpose, notice: financeTransaction.notice })
      .from(financeTransaction)
      .where(eq(financeTransaction.id, txId));
    expect(row.purpose).toBeNull();
    expect(row.notice).toBe("War mit Anna einkaufen\n\nBar bezahlt");
  });

  it("leaves non-cash (giro) transactions untouched", async () => {
    const giro = await ensureGiroAccount();
    const txId = await insertTx(giro, "Miete", null);

    await db.execute(sql.raw(MIGRATION_SQL));

    const [row] = await db
      .select({ purpose: financeTransaction.purpose, notice: financeTransaction.notice })
      .from(financeTransaction)
      .where(eq(financeTransaction.id, txId));
    expect(row.purpose).toBe("Miete");
    expect(row.notice).toBeNull();
  });

  it("leaves receipt-OCR auto-booked cash transactions untouched (legitimate purpose/notice split)", async () => {
    const cash = await ensureCashAccount();
    const txId = await insertTx(cash, "Milch, Joghurt, Brot", "Rossmann · 8,80 EUR");
    await db.execute(
      sql`INSERT INTO documents
            (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
             status, receipt_transaction_id)
          VALUES
            (${txId + 1_000_000}, ${USER_ID}, ${`sha-${txId}`}, 'beleg.pdf', 'application/pdf', 1,
             ${`/tmp/beleg-${txId}.pdf`}, 'ready', ${txId})`,
    );

    await db.execute(sql.raw(MIGRATION_SQL));

    const [row] = await db
      .select({ purpose: financeTransaction.purpose, notice: financeTransaction.notice })
      .from(financeTransaction)
      .where(eq(financeTransaction.id, txId));
    expect(row.purpose).toBe("Milch, Joghurt, Brot");
    expect(row.notice).toBe("Rossmann · 8,80 EUR");
  });

  it("leaves a cash transaction with no purpose untouched", async () => {
    const cash = await ensureCashAccount();
    const txId = await insertTx(cash, null, "Nur eine Notiz");

    await db.execute(sql.raw(MIGRATION_SQL));

    const [row] = await db
      .select({ purpose: financeTransaction.purpose, notice: financeTransaction.notice })
      .from(financeTransaction)
      .where(eq(financeTransaction.id, txId));
    expect(row.purpose).toBeNull();
    expect(row.notice).toBe("Nur eine Notiz");
  });
});
