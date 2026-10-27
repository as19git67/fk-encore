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
  isSecuritiesCandidate,
} from "./depot-derivation";
import { decideSecurity, findSecurity } from "./depot-securities";
import { deriveFromBookings } from "./portfolio";

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
    expect(extractIsin("REFERENZ XF00SONNE005Z xxxx")).toBeNull();
  });

  it("reads an ISIN the booking text prints with a space inside", () => {
    expect(extractIsin("SONNENOBST INC. WPKNR: SNN001 ISIN: XF00SO NNE005")).toBe("XF00SONNE005");
  });

  it("does not join a spaced ISIN whose check digit fails", () => {
    expect(extractIsin("ISIN: XF00SO NNE006")).toBeNull();
  });

  it("returns null on null/empty input", () => {
    expect(extractIsin(null)).toBeNull();
    expect(extractIsin("")).toBeNull();
    expect(extractIsin(undefined)).toBeNull();
  });
});

describe("extractWkn", () => {
  it("pulls a WKN after the 'WKN' prefix", () => {
    expect(extractWkn("WERTPAPIERABRECHNUNG KAUF WKN 987654 ANTEILE 5"))
      .toBe("987654");
  });

  it("handles colon separator", () => {
    expect(extractWkn("Kursabrechnung WKN: A1EWWW Stk 5")).toBe("A1EWWW");
  });

  it("handles the WKN/ISIN combined form", () => {
    // A broker's booking format: "WKN 987654 / LU0000098763"
    expect(extractWkn("WERTPAPIER WKN 987654 / LU0000098763 BEISPIEL GLOBAL"))
      .toBe("987654");
  });

  it("uppercases mixed-case WKN payloads", () => {
    expect(extractWkn("wkn a1ewww trades")).toBe("A1EWWW");
  });

  it("returns null when no 'WKN' prefix is present (avoid false positives)", () => {
    // 6-digit number in the purpose without the WKN anchor must not be
    // mistaken for a WKN — could be a reference, date, or amount.
    expect(extractWkn("AUFTRAGSNR 987654 KURS 42,00")).toBeNull();
  });

  it("handles the 'WPKNR:' prefix used on Wertpapierabrechnungen", () => {
    expect(extractWkn("SONNENOBST INC.\nWPKNR: SNN001  ISIN: XF00SONNE005"))
      .toBe("SNN001");
  });

  it("handles the 'WP-KENNNR' prefix", () => {
    expect(extractWkn("WP-KENNNR SNN001 STK 10")).toBe("SNN001");
  });

  it("reads the unlabelled WKN of a payout booking that quotes the holding", () => {
    expect(
      extractWkn("ERTRAEGNISGUTSCHRIFT VOM 01.02.26 DEPOTBESTAND: 10,000 SONNENOBST AG INH O.N. SNN001 EUR 0,25"),
    ).toBe("SNN001");
  });

  it("does not take a word of the name for the WKN of a quoted holding", () => {
    expect(extractWkn("DEPOTBESTAND: 10,000 SONNENOBST AG MUSTER EUR 0,25")).toBeNull();
  });

  it("returns null on null/empty input", () => {
    expect(extractWkn(null)).toBeNull();
    expect(extractWkn("")).toBeNull();
    expect(extractWkn(undefined)).toBeNull();
  });
});

describe("isSecuritiesCandidate", () => {
  it("accepts a SECU-flagged booking (camt path)", () => {
    expect(
      isSecuritiesCandidate({ funds_code: "SECU", purpose: "irgendwas" }),
    ).toBe(true);
  });

  it("rejects another BTC domain even when the text quotes an ISIN", () => {
    // A rent payment referencing an ISIN must never become a depot tx —
    // the bank told us this is Payments, so we trust it.
    expect(
      isSecuritiesCandidate({
        funds_code: "PMNT",
        purpose: "MIETE Verweis DE000A1EWWW0",
      }),
    ).toBe(false);
  });

  it("accepts an MT940 booking (single-letter funds code) carrying an ISIN", () => {
    expect(
      isSecuritiesCandidate({
        funds_code: "R",
        purpose: "SONNENOBST INC.\nWPKNR: SNN001  ISIN: XF00SONNE005",
      }),
    ).toBe(true);
  });

  it("accepts a null funds_code booking carrying a prefixed WKN", () => {
    expect(
      isSecuritiesCandidate({
        funds_code: null,
        purpose: "WERTPAPIERABRECHNUNG WKN 987654",
      }),
    ).toBe(true);
  });

  it("rejects an MT940 booking with no identifier in the text", () => {
    expect(
      isSecuritiesCandidate({ funds_code: "R", purpose: "SONNENOBST.TEST/BILL" }),
    ).toBe(false);
  });

  it("looks at entry_text as well as purpose", () => {
    expect(
      isSecuritiesCandidate({
        funds_code: "R",
        purpose: "Abrechnung",
        entry_text: "WERTPAPIERKAUF WKN SNN001",
      }),
    ).toBe(true);
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

  it("reads a settlement account's text when the bank gave no code", () => {
    const c = (amount: string, purpose: string) =>
      classifySecuTransaction({ amount, transaction_code: null, purpose });
    // Synthetic booking texts of a depot's settlement account.
    expect(c("-4.50", "VERWALTUNGSVERGUETUNG WKN AAA111")).toBeNull();
    expect(c("-2.10", "STEUER VORABPAUSCHALE ISIN DE000000AAA1")).toBeNull();
    expect(c("12.40", "ERTRAEGNISGUTSCHRIFT WKN AAA111")).toBe("dividend");
    expect(c("-12.40", "AUSSCHUETTUNG STORNO WKN AAA111")).toBeNull();
    // A trade's wording decides even next to a fee word.
    expect(c("-1000.00", "WERTPAPIERABRECHNUNG KAUF INKL. ENTGELT WKN AAA111")).toBe("buy");
    expect(c("990.00", "WERTPAPIERABRECHNUNG VERKAUF WKN AAA111")).toBe("sell");
  });

  it("takes a booking that quotes the settlement's amount for the trade, not for a tax", () => {
    const c = (amount: string, purpose: string) =>
      classifySecuTransaction({ amount, transaction_code: null, purpose });
    // Synthetic, worded like a broker's booking of a sale: no kind, only the
    // settlement's gross amount and the tax withheld from it.
    const text = "BEISPIEL AG DL-,01 WPKNR: AAA111 ISIN: DE000000AAA1 Abr.Betrag Brutto 1.000,00 EUR Steuerabzug 12,34- EUR";
    expect(c("987.66", text)).toBe("sell");
    expect(c("-1012.34", text.replace("Steuerabzug 12,34-", "Provision 12,34-"))).toBe("buy");
    expect(c("12.40", "DIVIDENDE WKN AAA111 Abr.Betrag 12,40 EUR")).toBe("dividend");
  });

  it("skips a tax correction that quotes the trade it corrects", () => {
    const c = (amount: string, purpose: string) =>
      classifySecuTransaction({ amount, transaction_code: null, purpose });
    // Synthetic text in the shape a settlement account books it.
    const text = "STEUERAUSGLEICH WERTPAPIERABRECHNUNG DEPOT-NR 0000000000 BEISPIEL FONDS WKN AAA111 / XF00SONNE005 HANDELSTAG 01.12.2011 MENGE 1,1840 KURS 8442,13200000";
    expect(c("12.34", text)).toBeNull();
    expect(c("-12.34", text)).toBeNull();
    expect(c("-12.34", "STEUERNACHBELASTUNG WERTPAPIERABRECHNUNG WKN AAA111")).toBeNull();
  });

  it("does not take money moved onto the settlement account for a sale", () => {
    const c = (amount: string, purpose: string) =>
      classifySecuTransaction({ amount, transaction_code: null, purpose });
    // The transfer that pays for a purchase, in the user's own words.
    expect(c("1000.00", "FUER KAUF WKN AAA111")).toBeNull();
    expect(c("1000.00", "UEBERWEISUNG DEPOT WKN AAA111")).toBeNull();
    expect(c("1000.00", "DAUERAUFTRAG SPARPLAN WKN AAA111")).toBeNull();
    // Money in with nothing but the identifier: a sale only on the bank's say-so.
    expect(c("1000.00", "WKN AAA111 FONDSNAME")).toBeNull();
    expect(classifySecuTransaction({ amount: "1000.00", transaction_code: "TRAD", purpose: "WKN AAA111" })).toBe("sell");
    // MT940's type code is not the bank's say-so.
    expect(classifySecuTransaction({ amount: "1000.00", transaction_code: "NMSC", purpose: "WKN AAA111" })).toBeNull();
    // Money out with "Verkauf" is no sale either.
    expect(c("-1000.00", "VERKAUF WKN AAA111")).toBeNull();
    // The purchase itself, with and without a word.
    expect(c("-1000.00", "WERTPAPIERKAUF WKN AAA111")).toBe("buy");
    expect(c("-1000.00", "WKN AAA111 FONDSNAME")).toBe("buy");
    // "Wertpapierabrechnung" alone names no direction: the sign decides.
    expect(c("990.00", "WERTPAPIERABRECHNUNG WKN AAA111")).toBe("sell");
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
      isin: "XF00SONNE005",
      name: "SONNENOBST",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-06-01",
      amount: "12.34",
      purpose: "DIVIDENDE SONNENOBST XF00SONNE005",
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

  it("derives an MT940 booking (single-letter funds_code) via the purpose ISIN", async () => {
    // The reported bug: HKKAZ/MT940 statements put a single letter in
    // subfield 4 of :61: (here "R"), never the ISO BTC domain "SECU", so
    // the old funds_code='SECU' gate skipped every such booking.
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "XF00SONNE005",
      wkn: "SNN001",
      name: "SONNENOBST INC.",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-06-01",
      amount: "-1500.00",
      purpose: "SONNENOBST INC.\nWPKNR: SNN001  ISIN: XF00SONNE005",
      funds_code: "R",
      transaction_code: null,
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.candidates).toBe(1);
    expect(stats.derived).toBe(1);
    expect(stats.skipped).toBe(0);

    const [row] = await db
      .select()
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.account_id, depot));
    expect(row.kind).toBe("buy");
    expect(row.isin).toBe("XF00SONNE005");
    expect(row.wkn).toBe("SNN001");
    expect(row.net_amount).toBe("-1500.00");
  });

  it("reports skipped_no_holding when the identifier matches no position", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    await insertAccount(bcId, "depot", "DEPOT-1");
    // Depot has no holdings synced yet.
    await insertTx({
      accountId: giro,
      bookingDate: "2026-06-01",
      amount: "-1500.00",
      purpose: "SONNENOBST INC.\nWPKNR: SNN001  ISIN: XF00SONNE005",
      funds_code: "R",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.candidates).toBe(1);
    expect(stats.derived).toBe(0);
    expect(stats.skipped_no_holding).toBe(1);
    expect(stats.skipped_no_identifier).toBe(0);
  });

  it("does not treat a subscription charge naming the security as a securities booking", async () => {
    // "SONNENOBST.TEST/BILL" matches the holding name by words, but carries no
    // ISIN/WKN and no SECU flag — it must never reach the name fallback.
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "XF00SONNE005",
      name: "SONNENOBST INC.",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-06-02",
      amount: "-9.99",
      purpose: "SONNENOBST.TEST/BILL ABO",
      funds_code: "R",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.candidates).toBe(0);
    expect(stats.derived).toBe(0);
  });

  it("takes the depot of earlier rows when a closed position has no holding", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    // Read from a settlement document; no holdings snapshot ever showed it.
    await db.insert(financeDepotTransaction).values({
      account_id: depot,
      isin: "XF00SONNE005",
      wkn: "SNN001",
      name: "SONNENOBST INC.",
      kind: "sell",
      executed_at: "2026-03-10",
      amount: "5",
      net_amount: "1100.00",
      currency: "EUR",
      source: "document",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-02-03",
      amount: "-1000.00",
      purpose: "WERTPAPIERKAUF SONNENOBST INC. WPKNR: SNN001 ISIN: XF00SO NNE005",
      funds_code: "R",
    });

    // Known only from earlier rows: proposed to the user, not booked.
    const first = await deriveDepotTransactionsForBankcontact(bcId);
    expect(first.derived).toBe(0);
    expect(first.skipped_unconfirmed).toBe(1);
    const proposal = await findSecurity(depot, { isin: "XF00SONNE005", wkn: null });
    expect(proposal).toMatchObject({ status: "proposed", source: "booking", wkn: "SNN001", name: "SONNENOBST INC." });

    // Taken in: the booking is derived.
    await ensureUser(1);
    await decideSecurity(proposal!.id, "confirm", 1);
    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(1);
    const [row] = await db
      .select()
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.source, "giro-derived"));
    expect(row).toMatchObject({
      account_id: depot,
      kind: "buy",
      isin: "XF00SONNE005",
      wkn: "SNN001",
      name: "SONNENOBST INC.",
      net_amount: "-1000.00",
    });
  });

  it("proposes a security no depot knows to the bankcontact's only depot, and the bank's holdings confirm it", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    const txId = await insertTx({
      accountId: giro,
      bookingDate: "2026-02-03",
      amount: "-1000.00",
      purpose: "WERTPAPIERKAUF WPKNR: SNN001 ISIN: XF00SONNE005",
      funds_code: "R",
    });
    const first = await deriveDepotTransactionsForBankcontact(bcId);
    expect(first).toMatchObject({ derived: 0, skipped_no_holding: 1 });
    expect(await findSecurity(depot, { isin: "XF00SONNE005", wkn: null })).toMatchObject({ status: "proposed", source: "booking" });

    // Ignored: still nothing, silently.
    await ensureUser(1);
    const sec = (await findSecurity(depot, { isin: "XF00SONNE005", wkn: null }))!;
    await decideSecurity(sec.id, "ignore", 1);
    await insertHolding({ accountId: depot, asOf: "2026-05-15", isin: "XF00SONNE005", wkn: "SNN001", name: "SONNENOBST INC." });
    expect((await deriveDepotTransactionsForBankcontact(bcId)).skipped_unconfirmed).toBe(1);

    // Proposed again, and the bank's holdings settle it.
    await decideSecurity(sec.id, "propose", 1);
    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(1);
    expect(await findSecurity(depot, { isin: "XF00SONNE005", wkn: null })).toMatchObject({ status: "confirmed", source: "bank" });
    const rows = await db.select().from(financeDepotTransaction).where(eq(financeDepotTransaction.linked_transaction_id, txId));
    expect(rows).toHaveLength(1);
  });

  it("does not guess between two depots that both have rows of the security", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    for (const label of ["DEPOT-1", "DEPOT-2"]) {
      const depot = await insertAccount(bcId, "depot", label);
      await db.insert(financeDepotTransaction).values({
        account_id: depot,
        wkn: "SNN001",
        kind: "buy",
        executed_at: "2026-01-10",
        currency: "EUR",
        source: "document",
      });
    }
    await insertTx({
      accountId: giro,
      bookingDate: "2026-02-03",
      amount: "-1000.00",
      purpose: "WERTPAPIERKAUF WPKNR: SNN001",
      funds_code: "R",
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(0);
    expect(stats.skipped_no_holding).toBe(1);
  });

  it("attaches a payout booking quoting the holding to the row its paper created", async () => {
    // MT940 gives no BTC domain; the booking names the WKN only through the
    // quoted holding, while the bank's holdings list just the ISIN.
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-01-15",
      isin: "XF00SONNE005",
      name: "SONNENOBST AG INH O.N.",
    });
    const [docRow] = await db
      .insert(financeDepotTransaction)
      .values({
        account_id: depot,
        isin: "XF00SONNE005",
        wkn: "SNN001",
        name: "SONNENOBST AG",
        kind: "dividend",
        executed_at: "2026-02-02",
        gross_amount: "3.40",
        tax: "0.90",
        net_amount: "2.50",
        currency: "EUR",
        source: "document",
        dedupe_hash: "doc:1",
      })
      .returning({ id: financeDepotTransaction.id });
    const txId = await insertTx({
      accountId: giro,
      bookingDate: "2026-02-01",
      amount: "2.50",
      purpose: "ERTRAEGNISGUTSCHRIFT VOM 02.02.26 DEPOTBESTAND: 10,000 SONNENOBST AG INH O.N. SNN001 EUR 0,34",
      funds_code: "R",
      transaction_code: null,
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.candidates).toBe(1);
    expect(stats.merged).toBe(1);
    expect(stats.derived).toBe(0);

    const rows = await db
      .select()
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.account_id, depot));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(docRow.id);
    expect(rows[0].linked_transaction_id).toBe(txId);
  });

  it("does not take the name when the holding's identifier contradicts the booking's", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-01-15",
      isin: "XF00SONNE005",
      wkn: "SNN002",
      name: "SONNENOBST AG",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-02-01",
      amount: "2.50",
      purpose: "ERTRAEGNISGUTSCHRIFT DEPOTBESTAND: 10,000 SONNENOBST AG SNN001 EUR 0,25",
      funds_code: "R",
      transaction_code: null,
    });

    const stats = await deriveDepotTransactionsForBankcontact(bcId);
    expect(stats.derived).toBe(0);
    expect(stats.merged).toBe(0);
  });

  it("falls back to matching by holding name when purpose has no ISIN/WKN", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "XF00SONNE005",
      wkn: "SNN001",
      name: "SONNENOBST INC.",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-06-01",
      amount: "-1500.00",
      purpose: "SONNENOBST INC.",
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
    expect(row.isin).toBe("XF00SONNE005");
    expect(row.wkn).toBe("SNN001");
  });

  it("skips the name fallback when it would be ambiguous across holdings", async () => {
    const bcId = await insertBankcontact();
    const giro = await insertAccount(bcId, "giro", "GIRO-1");
    const depot = await insertAccount(bcId, "depot", "DEPOT-1");
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-15",
      isin: "XF00SONNE005",
      name: "SONNENOBST INC.",
    });
    await insertHolding({
      accountId: depot,
      asOf: "2026-05-16",
      isin: "US0000000001",
      name: "SONNENOBST HOLDINGS SE",
    });
    await insertTx({
      accountId: giro,
      bookingDate: "2026-06-01",
      amount: "-1500.00",
      purpose: "SONNENOBST",
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
    // Some brokers' holdings: ISIN column blank, only WKN populated.
    await insertHolding({
      accountId: depot,
      asOf: "2026-04-21",
      isin: null,
      wkn: "987654",
      name: "BEISPIEL GLOBAL FONDS A",
    });
    // The broker's booking text: WKN before "/", ISIN after.
    const giroTxId = await insertTx({
      accountId: giro,
      bookingDate: "2026-04-21",
      amount: "250.00",
      purpose:
        "WERTPAPIERABRECHNUNG VERKAUF WKN 987654 / LU0000098763 BEISPIEL GLOBAL FONDS A",
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
    expect(row.isin).toBe("LU0000098763");
    expect(row.wkn).toBe("987654");
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
      wkn: "987654",
      name: "BEISPIEL GLOBAL FONDS A",
    });
    // 987654 appears as an "AUFTRAGSNR" — not as a WKN. Without a WKN
    // prefix the extraction must skip it, and since the booking has no
    // ISIN either there's nothing to match.
    await insertTx({
      accountId: giro,
      bookingDate: "2026-05-10",
      amount: "-50.00",
      purpose: "GEBÜHR AUFTRAGSNR 987654",
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

describe("finance/portfolio — deriveFromBookings endpoint", () => {
  it("derives for every bank contact of the depots in scope and adds up the stats", async () => {
    await ensureUser(1);
    for (const n of [1, 2]) {
      const bcId = await insertBankcontact(`Bank ${n}`);
      const giro = await insertAccount(bcId, "giro", `GIRO-${n}`);
      const depot = await insertAccount(bcId, "depot", `DEPOT-${n}`);
      await insertHolding({ accountId: depot, asOf: "2026-05-15", isin: "DE000A1EWWW0", name: "BEISPIEL AG" });
      await insertTx({
        accountId: giro,
        bookingDate: "2026-05-10",
        amount: "-1000",
        purpose: "WERTPAPIERABRECHNUNG KAUF DE000A1EWWW0",
        funds_code: "SECU",
        transaction_code: "TRAD",
      });
      await db.insert(financeAccountAccess).values({ account_id: depot, user_id: 1, level: "write" });
    }
    await insertAccount(null, "depot", "MANUAL-DEPOT");
    setAuth("1", ["finance.view"]);

    const resp = await deriveFromBookings({});
    expect(resp.derived).toBe(2);
    expect(resp.candidates).toBe(2);
    expect(resp.errors).toEqual([]);

    const again = await deriveFromBookings({});
    expect(again.derived).toBe(0);
    expect(again.duplicates).toBe(2);
  });

  it("refuses without a depot the caller may write to", async () => {
    const bcId = await insertBankcontact();
    await insertAccount(bcId, "depot", "DEPOT-1");
    await ensureUser(2);
    setAuth("2", ["finance.view"]);

    await expect(deriveFromBookings({})).rejects.toThrow(/write access/);
  });
});
