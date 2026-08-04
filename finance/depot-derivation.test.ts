import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountHolding,
  financeAccountType,
  financeBankcontact,
  financeCurrency,
  financeDepotTransaction,
  financeTagTransaction,
  financeTransaction,
  users,
} from "../db/schema";
import {
  classifySecuTransaction,
  deriveDepotTransactionsForBankcontact,
  extractIsin,
  extractWkn,
} from "./depot-derivation";
import { deriveDepotTransactionsFromGiro } from "./depot-transactions";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeDepotTransaction);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeAccountHolding);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  setAuth("1", []);
});

async function insertBankcontact(name = "Test"): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({ name, blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

async function typeIdFor(kind: string): Promise<number> {
  const [row] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .where(eq(financeAccountType.kind, kind))
    .limit(1);
  return row.id;
}

async function insertAccount(
  bankcontactId: number | null,
  kind: string,
  label: string,
): Promise<number> {
  const typeId = await typeIdFor(kind);
  const [row] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bankcontactId,
      type_id: typeId,
      currency_code: "EUR",
      account_number: label,
      label,
    })
    .returning({ id: financeAccount.id });
  return row.id;
}

async function insertHolding(opts: {
  accountId: number;
  asOf: string;
  isin?: string | null;
  wkn?: string | null;
  name: string;
}): Promise<void> {
  await db.insert(financeAccountHolding).values({
    account_id: opts.accountId,
    as_of: opts.asOf,
    isin: opts.isin ?? null,
    wkn: opts.wkn ?? null,
    name: opts.name,
    amount: "5",
    price: "200.00",
    value: "1000.00",
    currency: "EUR",
  });
}

interface InsertTxOpts {
  accountId: number;
  bookingDate: string;
  amount: string;
  purpose: string;
  funds_code?: string | null;
  transaction_code?: string | null;
  counterparty?: string | null;
}

async function insertTx(opts: InsertTxOpts): Promise<number> {
  const [row] = await db
    .insert(financeTransaction)
    .values({
      account_id: opts.accountId,
      booking_date: opts.bookingDate,
      value_date: opts.bookingDate,
      amount: opts.amount,
      currency_code: "EUR",
      purpose: opts.purpose,
      counterparty: opts.counterparty ?? null,
      funds_code: opts.funds_code ?? null,
      transaction_code: opts.transaction_code ?? null,
      dedupe_hash:
        opts.bookingDate +
        "|" +
        opts.amount +
        "|" +
        opts.purpose +
        "|" +
        Math.random(),
    })
    .returning({ id: financeTransaction.id });
  return row.id;
}

describe("extractIsin", () => {
  it("pulls a valid ISIN out of free text", () => {
    expect(
      extractIsin("WERTPAPIERABRECHNUNG KAUF ADIDAS DE000A1EWWW0 Stück 5"),
    ).toBe("DE000A1EWWW0");
  });

  it("returns null for text without an ISIN", () => {
    expect(extractIsin("DAUERAUFTRAG Miete")).toBeNull();
  });

  it("returns null for an ISIN-shaped string with a non-digit check char", () => {
    // 13th char must be 0-9; "Z" doesn't match the trailing [0-9].
    expect(extractIsin("REFERENZ US0378331005Z xxxx")).toBeNull();
  });

  it("returns null on null/empty input", () => {
    expect(extractIsin(null)).toBeNull();
    expect(extractIsin("")).toBeNull();
    expect(extractIsin(undefined)).toBeNull();
  });
});

describe("extractWkn", () => {
  it("pulls a WKN after the 'WKN' prefix", () => {
    expect(extractWkn("WERTPAPIERABRECHNUNG KAUF WKN 930921 ANTEILE 5"))
      .toBe("930921");
  });

  it("handles colon separator", () => {
    expect(extractWkn("Kursabrechnung WKN: A1EWWW Stk 5")).toBe("A1EWWW");
  });

  it("handles the WKN/ISIN combined form", () => {
    // Real MLP booking format: "WKN 930921 / LU0106280919"
    expect(extractWkn("WERTPAPIER WKN 930921 / LU0106280919 SAUREN GLOB"))
      .toBe("930921");
  });

  it("uppercases mixed-case WKN payloads", () => {
    expect(extractWkn("wkn a1ewww trades")).toBe("A1EWWW");
  });

  it("returns null when no 'WKN' prefix is present (avoid false positives)", () => {
    // 6-digit number in the purpose without the WKN anchor must not be
    // mistaken for a WKN — could be a reference, date, or amount.
    expect(extractWkn("AUFTRAGSNR 930921 KURS 56,19")).toBeNull();
  });

  it("returns null on null/empty input", () => {
    expect(extractWkn(null)).toBeNull();
    expect(extractWkn("")).toBeNull();
    expect(extractWkn(undefined)).toBeNull();
  });
});

describe("classifySecuTransaction", () => {
  it("classifies DVCA subfamily as dividend", () => {
    expect(
      classifySecuTransaction({ amount: "12.50", transaction_code: "DVCA" }),
    ).toBe("dividend");
  });

  it("treats CHRG (custody fee) as skip", () => {
    expect(
      classifySecuTransaction({ amount: "-2.50", transaction_code: "CHRG" }),
    ).toBeNull();
  });

  it("falls back to sign for sell (positive)", () => {
    expect(
      classifySecuTransaction({ amount: "1000.00", transaction_code: "TRAD" }),
    ).toBe("sell");
  });

  it("falls back to sign for buy (negative)", () => {
    expect(
      classifySecuTransaction({ amount: "-1000.00", transaction_code: null }),
    ).toBe("buy");
  });

  it("skips zero/non-numeric amounts", () => {
    expect(
      classifySecuTransaction({ amount: "0.00", transaction_code: null }),
    ).toBeNull();
    expect(
      classifySecuTransaction({ amount: "abc", transaction_code: null }),
    ).toBeNull();
  });
});

describe("deriveDepotTransactionsForBankcontact", () => {
  it("derives a buy from a negative SECU giro booking matched by ISIN", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "DE000A1EWWW0",
      wkn: "A1EWWW",
      name: "ADIDAS",
    });
    const giroTxId = await insertTx({
      accountId: giro,
      bookingDate: "2026-05-10",
      amount: "-1009.90",
      purpose: "WERTPAPIERABRECHNUNG KAUF ADIDAS DE000A1EWWW0 Stk 5",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.errors).toEqual([]);

    const rows = await db
      .select()
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.account_id, depot));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("buy");
    expect(rows[0].isin).toBe("DE000A1EWWW0");
    expect(rows[0].wkn).toBe("A1EWWW");
    expect(rows[0].name).toBe("ADIDAS");
    expect(rows[0].source).toBe("giro-derived");
    expect(rows[0].linked_transaction_id).toBe(giroTxId);
    expect(rows[0].net_amount).toBe("-1009.90");
    expect(rows[0].gross_amount).toBe("1009.90");
    expect(rows[0].executed_at).toMatch(/^2026-05-10/);
    expect(rows[0].dedupe_hash).toBe(`giro:${giroTxId}`);
  });

  it("derives dividends (DVCA) with positive net_amount", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "US0378331005",
      name: "APPLE",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-06-01",
      amount: "12.34",
      purpose: "DIVIDENDE APPLE US0378331005",
      funds_code: "SECU",
      transaction_code: "DVCA",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(1);
    const [row] = await db
      .select()
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.account_id, depot));
    expect(row.kind).toBe("dividend");
    expect(row.net_amount).toBe("12.34");
  });

  it("derives a sell when amount is positive and SECU/TRAD", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-20",
      amount: "1100.00",
      purpose: "WERTPAPIERABRECHNUNG VERKAUF ADIDAS DE000A1EWWW0",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(1);
    const [row] = await db
      .select()
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.account_id, depot));
    expect(row.kind).toBe("sell");
  });

  it("skips custody fees (CHRG)", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-31",
      amount: "-2.50",
      purpose: "DEPOTGEBÜHR DE000A1EWWW0",
      funds_code: "SECU",
      transaction_code: "CHRG",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(0);
    expect(stats.skipped).toBe(1);
    const rows = await db.select().from(financeDepotTransaction);
    expect(rows).toHaveLength(0);
  });

  it("skips SECU bookings without an ISIN match in known holdings", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    await insertAccount(bcId, "depot", "DEPOT-1");
    // Note: no holding inserted, so the ISIN won't match.
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-10",
      amount: "-500.00",
      purpose: "WERTPAPIERABRECHNUNG KAUF FOO DE000A1EWWW0",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it("falls back to matching by holding name when purpose has no ISIN/WKN", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "US0378331005",
      wkn: "865985",
      name: "APPLE INC.",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-06-01",
      amount: "-1500.00",
      purpose: "APPLE INC.",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(1);
    expect(stats.skipped).toBe(0);

    const [row] = await db
      .select()
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.account_id, depot));
    expect(row.kind).toBe("buy");
    expect(row.isin).toBe("US0378331005");
    expect(row.wkn).toBe("865985");
  });

  it("skips the name fallback when it would be ambiguous across holdings", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "US0378331005",
      name: "APPLE INC.",
    });
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-16",
      isin: "US0000000001",
      name: "APPLE HOLDINGS SE",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-06-01",
      amount: "-1500.00",
      purpose: "APPLE",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it("ignores transactions outside of SECU domain", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
    });
    // Regular SEPA payment that happens to mention an ISIN — must not
    // be turned into a depot transaction.
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-10",
      amount: "-50.00",
      purpose: "MIETE Verweis DE000A1EWWW0",
      funds_code: "PMNT",
      transaction_code: "ESCT",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(0);
    const rows = await db.select().from(financeDepotTransaction);
    expect(rows).toHaveLength(0);
  });

  it("is idempotent — re-running does not duplicate rows", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-10",
      amount: "-1009.90",
      purpose: "WERTPAPIERABRECHNUNG KAUF DE000A1EWWW0",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    const first = await deriveDepotTransactionsForBankcontact(bcId);
    const second = await deriveDepotTransactionsForBankcontact(bcId);
    expect(first.derived).toBe(1);
    expect(second.derived).toBe(0);
    expect(second.duplicates).toBe(1);

    const rows = await db.select().from(financeDepotTransaction);
    expect(rows).toHaveLength(1);
  });

  it("picks the depot with the most recent matching holding on tie", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depotOld = await insertAccount(bcId, "depot", "DEPOT-OLD");
    const depotNew = await insertAccount(bcId, "depot", "DEPOT-NEW");
    await insertHolding({
      accountId: depotOld,
      asOf: "2025-01-01",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
    });
    await insertHolding({
      accountId: depotNew,
      asOf: "2026-05-15",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-10",
      amount: "-1000",
      purpose: "WERTPAPIERABRECHNUNG KAUF DE000A1EWWW0",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    await deriveDepotTransactionsForBankcontact(bcId);
    const rows = await db.select().from(financeDepotTransaction);
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe(depotNew);
  });

  it("matches a holding by WKN when the holding has no ISIN (MLP case)", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    // Real-world MLP holdings: ISIN column blank, only WKN populated.
    await insertHolding({
      accountId: depot,
      asOf: "2026-04-21",
      isin: null,
      wkn: "930921",
      name: "SAUREN GLOB.OPPS A",
    });
    // Real MLP booking text: WKN before "/", ISIN after.
    const giroTxId = await insertTx({
      accountId: giro,
      bookingDate: "2026-04-21",
      amount: "234.32",
      purpose:
        "WERTPAPIERABRECHNUNG VERKAUF WKN 930921 / LU0106280919 SAUREN GLOB.OPPS A",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(1);
    expect(stats.skipped).toBe(0);

    const [row] = await db
      .select()
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.account_id, depot));
    expect(row.kind).toBe("sell");
    // ISIN was present in the booking text — keep it on the row even
    // though the holding had none, so future syncs can backfill it.
    expect(row.isin).toBe("LU0106280919");
    expect(row.wkn).toBe("930921");
    expect(row.linked_transaction_id).toBe(giroTxId);
  });

  it("matches by WKN when the booking has no ISIN but holding has it", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "DE000A1EWWW0",
      wkn: "A1EWWW",
      name: "ADIDAS",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-10",
      amount: "-500.00",
      purpose: "WERTPAPIERABRECHNUNG KAUF WKN A1EWWW STK 5",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(1);
    const [row] = await db
      .select()
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.account_id, depot));
    expect(row.kind).toBe("buy");
    // WKN drove the match — fall back to the holding's ISIN for the row.
    expect(row.isin).toBe("DE000A1EWWW0");
    expect(row.wkn).toBe("A1EWWW");
  });

  it("does not match on a stray 6-digit number without a 'WKN' prefix", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: null,
      wkn: "930921",
      name: "SAUREN GLOB.OPPS A",
    });
    // 930921 appears as an "AUFTRAGSNR" — not as a WKN. Without a WKN
    // prefix the extraction must skip it, and since the booking has no
    // ISIN either there's nothing to match.
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-10",
      amount: "-50.00",
      purpose: "GEBÜHR AUFTRAGSNR 930921",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it("stays within the bankcontact — does not match a depot on another bank", async () => {
    const bcId = await insertBankcontact("Bank A");
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const otherBc = await insertBankcontact("Bank B");
    const otherDepot = await insertAccount(otherBc, "depot", "DEPOT-OTHER");
    await insertHolding({
      accountId: otherDepot,
      asOf: "2026-05-15",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-10",
      amount: "-1000",
      purpose: "WERTPAPIERABRECHNUNG KAUF DE000A1EWWW0",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(0);
    expect(stats.skipped).toBe(1);
  });
});

describe("finance/depot-transactions — deriveDepotTransactionsFromGiro endpoint", () => {
  it("triggers derivation for the bankcontact and reports stats", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "DE000A1EWWW0",
      name: "ADIDAS",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-10",
      amount: "-1000",
      purpose: "WERTPAPIERABRECHNUNG KAUF DE000A1EWWW0",
      funds_code: "SECU",
      transaction_code: "TRAD",
    });
    await ensureUser(1);
    await db.insert(financeAccountAccess).values({
      account_id: depot,
      user_id: 1,
      level: "write",
    });
    setAuth("1", ["finance.view"]);

    const resp = await deriveDepotTransactionsFromGiro({ id: depot });
    expect(resp.derived).toBe(1);
    expect(resp.errors).toEqual([]);
  });

  it("denies derivation with only read ACL", async () => {
    const bcId = await insertBankcontact();
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await ensureUser(2);
    await db.insert(financeAccountAccess).values({
      account_id: depot,
      user_id: 2,
      level: "read",
    });
    setAuth("2", ["finance.view"]);

    await expect(
      deriveDepotTransactionsFromGiro({ id: depot }),
    ).rejects.toThrow(/write access required/);
  });

  it("refuses on a manual account (no bankcontact)", async () => {
    const depot = await insertAccount(null, "depot", "MANUAL-DEPOT");
    setAuth("9", ["finance.view", "finance.admin"]);

    await expect(
      deriveDepotTransactionsFromGiro({ id: depot }),
    ).rejects.toThrow(/no bankcontact/);
  });
});
