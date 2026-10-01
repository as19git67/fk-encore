import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  documents,
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountHolding,
  financeAccountType,
  financeBankcontact,
  financeDepotTransaction,
  financeDepotTransactionDocument,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  users,
} from "../db/schema";
import { enrichDocument, enrichPendingDocuments } from "./depot-document-enrichment";
import { deriveDepotTransactionsForBankcontact } from "./depot-derivation";
import {
  applySettlementDocument,
  enrichDepotTransactionsFromDocuments,
  getPortfolio,
  getPortfolioPosition,
  getPortfolioReview,
  inspectSettlementDocument,
  listPortfolioTransactions,
} from "./portfolio";

// Synthetic identifiers and texts only — see CLAUDE.md "Keine PII".
const ISIN_A = "DE000000AAA1";

const BUY_TEXT = `Beispielbank AG
Wertpapierabrechnung Kauf
Stück 25
Wertpapierbezeichnung
Alpha Industries AG
ISIN ${ISIN_A}
Schlusstag 14.03.2026
Ausführungskurs 118,40 EUR
Kurswert 2.960,00 EUR
Provision 4,90 EUR
Handelsplatzgebühr 1,50 EUR
Ausmachender Betrag 2.966,40 EUR`;

const DIVIDEND_TEXT = `Beispielbank AG
Dividendengutschrift
Alpha Industries AG ISIN ${ISIN_A}
Stück 25
Dividende pro Stück 2,00 EUR
Bruttobetrag 50,00 EUR
Kapitalertragsteuer 12,50 EUR
Solidaritätszuschlag 0,68 EUR
Zahlbarkeitstag 12.05.2026
Betrag zu Ihren Gunsten 36,82 EUR`;

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
  await db.delete(financeDepotTransactionDocument);
  await db.delete(financeDepotTransaction);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeAccountHolding);
  await db.delete(financeAccountBalance);
  await db.delete(financeTanSession);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(documents);
  await db.delete(users);
  await ensureUser(1);
  setAuth("1", ["finance.view", "finance.admin"]);
});

async function setup(): Promise<{ bc: number; giro: number; depot: number }> {
  const [bcRow] = await db
    .insert(financeBankcontact)
    .values({ name: "Test", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  const typeId = async (kind: "depot" | "giro") =>
    (await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, kind)).limit(1))[0]!.id;
  const [giro] = await db
    .insert(financeAccount)
    .values({ bankcontact_id: bcRow!.id, type_id: await typeId("giro"), currency_code: "EUR", account_number: "giro-1", label: "Verrechnung" })
    .returning({ id: financeAccount.id });
  const [depot] = await db
    .insert(financeAccount)
    .values({ bankcontact_id: bcRow!.id, type_id: await typeId("depot"), currency_code: "EUR", account_number: "depot-1", label: "Depot" })
    .returning({ id: financeAccount.id });
  await db.insert(financeAccountHolding).values({
    account_id: depot!.id,
    as_of: "2026-03-01",
    isin: ISIN_A,
    name: "Alpha Industries AG",
    amount: "25",
    price: "118.00",
    value: "2950.00",
    currency: "EUR",
  });
  return { bc: bcRow!.id, giro: giro!.id, depot: depot!.id };
}

let docCounter = 0;
async function insertDocument(text: string, opts: { userId?: number; status?: "ready" | "pending" } = {}): Promise<number> {
  docCounter += 1;
  const name = `settlement-${docCounter}-${Math.random().toString(36).slice(2)}`;
  const [row] = await db
    .insert(documents)
    .values({
      user_id: opts.userId ?? 1,
      sha256: name.padEnd(64, "0"),
      original_filename: `${name}.pdf`,
      mime_type: "application/pdf",
      size_bytes: 1,
      disk_path: `/tmp/${name}.pdf`,
      title: name,
      status: opts.status ?? "ready",
      extracted_text: text,
    })
    .returning({ id: documents.id });
  return row!.id;
}

async function insertGiroBooking(accountId: number, date: string, amount: string): Promise<number> {
  const [row] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: date,
      value_date: date,
      amount,
      currency_code: "EUR",
      purpose: `WERTPAPIERABRECHNUNG ALPHA INDUSTRIES AG ISIN ${ISIN_A}`,
      funds_code: "SECU",
      dedupe_hash: `${date}|${amount}|${Math.random()}`,
    })
    .returning({ id: financeTransaction.id });
  return row!.id;
}

async function depotRows(depot: number) {
  return db.select().from(financeDepotTransaction).where(eq(financeDepotTransaction.account_id, depot));
}

describe("finance/depot-document-enrichment", () => {
  it("creates a full transaction from a settlement when no booking exists yet", async () => {
    const { depot } = await setup();
    const docId = await insertDocument(BUY_TEXT);

    const r = await enrichDocument(docId);
    expect(r.outcome).toBe("created");
    expect(r.account_id).toBe(depot);

    const rows = await depotRows(depot);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("buy");
    expect(row.source).toBe("document");
    expect(row.executed_at.slice(0, 10)).toBe("2026-03-14");
    expect(Number(row.amount)).toBe(25);
    expect(row.price).toBe("118.400000");
    expect(row.gross_amount).toBe("2960.00");
    expect(row.fees).toBe("6.40");
    expect(row.net_amount).toBe("-2966.40");
    expect(row.dedupe_hash).toBe(`doc:${docId}`);

    // Idempotent: a second run only reports the link.
    const again = await enrichDocument(docId);
    expect(again.outcome).toBe("already_linked");
    expect(await depotRows(depot)).toHaveLength(1);
  });

  it("enriches the giro-derived row instead of creating a second one", async () => {
    const { bc, giro, depot } = await setup();
    const bookingId = await insertGiroBooking(giro, "2026-03-16", "-2966.40");
    await deriveDepotTransactionsForBankcontact(bc);
    const [derived] = await depotRows(depot);
    expect(derived!.source).toBe("giro-derived");
    expect(derived!.amount).toBeNull();

    const docId = await insertDocument(BUY_TEXT);
    const r = await enrichDocument(docId);
    expect(r.outcome).toBe("enriched");
    expect(r.depot_transaction_id).toBe(derived!.id);

    const rows = await depotRows(depot);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.source).toBe("giro-derived+document");
    expect(row.linked_transaction_id).toBe(bookingId);
    expect(Number(row.amount)).toBe(25);
    expect(row.price).toBe("118.400000");
    expect(row.fees).toBe("6.40");
    // The booking's own values are kept.
    expect(row.net_amount).toBe("-2966.40");
    expect(row.executed_at.slice(0, 10)).toBe("2026-03-16");
  });

  it("merges a later giro booking into the row the document created", async () => {
    const { bc, giro, depot } = await setup();
    const docId = await insertDocument(BUY_TEXT);
    expect((await enrichDocument(docId)).outcome).toBe("created");

    const bookingId = await insertGiroBooking(giro, "2026-03-16", "-2966.40");
    const stats = await deriveDepotTransactionsForBankcontact(bc);
    expect(stats.merged).toBe(1);
    expect(stats.derived).toBe(0);

    const rows = await depotRows(depot);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.linked_transaction_id).toBe(bookingId);
    expect(rows[0]!.source).toBe("document");

    // A rerun neither merges again nor derives a duplicate.
    const rerun = await deriveDepotTransactionsForBankcontact(bc);
    expect(rerun.merged).toBe(0);
    expect(rerun.derived).toBe(0);
    expect(rerun.duplicates).toBe(1);
    expect(await depotRows(depot)).toHaveLength(1);
  });

  it("reports a conflict instead of overwriting a booking with a different net", async () => {
    const { bc, giro, depot } = await setup();
    await insertGiroBooking(giro, "2026-03-16", "-2900.00");
    await deriveDepotTransactionsForBankcontact(bc);

    const docId = await insertDocument(BUY_TEXT);
    const r = await enrichDocument(docId);
    expect(r.outcome).toBe("conflict");
    expect(r.detail).toContain("-2966.40");

    const rows = await depotRows(depot);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.net_amount).toBe("-2900.00");
    expect(rows[0]!.amount).toBeNull();
  });

  it("skips documents that are not settlements or whose security no depot holds", async () => {
    await setup();
    const invoice = await insertDocument("Rechnung Nr. 1 über 120,00 EUR");
    expect((await enrichDocument(invoice)).outcome).toBe("not_settlement");

    const foreign = await insertDocument(BUY_TEXT.replace(ISIN_A, "DE000000ZZZ9"));
    expect((await enrichDocument(foreign)).outcome).toBe("no_holding");

    const pending = await insertDocument(BUY_TEXT, { status: "pending" });
    expect((await enrichDocument(pending)).outcome).toBe("not_settlement");
  });

  it("keeps a document away from depots its owner cannot access", async () => {
    const { depot } = await setup();
    await ensureUser(2);
    await ensureUser(3);
    // User 2 has access to some other account but not to this depot.
    const [other] = await db
      .insert(financeAccount)
      .values({
        type_id: (await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, "giro")).limit(1))[0]!.id,
        currency_code: "EUR",
        account_number: "other",
        label: "Other",
      })
      .returning({ id: financeAccount.id });
    await db.insert(financeAccountAccess).values({ account_id: other!.id, user_id: 2, level: "read" });

    const docId = await insertDocument(BUY_TEXT, { userId: 2 });
    expect((await enrichDocument(docId)).outcome).toBe("no_holding");
    expect(await depotRows(depot)).toHaveLength(0);

    // Once given access, the same document lands.
    await db.insert(financeAccountAccess).values({ account_id: depot, user_id: 2, level: "read" });
    expect((await enrichDocument(docId)).outcome).toBe("created");
  });

  it("backfills pending settlements and exposes the links in the transaction list", async () => {
    const { depot } = await setup();
    const buy = await insertDocument(BUY_TEXT);
    const dividend = await insertDocument(DIVIDEND_TEXT);
    await insertDocument("Kontoauszug ohne Wertpapierbezug");

    const stats = await enrichPendingDocuments([depot]);
    expect(stats.created).toBe(2);
    expect(stats.documents_examined).toBe(2);

    const list = await listPortfolioTransactions({});
    expect(list.items.map((i) => [i.kind, i.document_ids])).toEqual([
      ["dividend", [dividend]],
      ["buy", [buy]],
    ]);
    const div = list.items[0]!;
    expect(div.tax).toBe("13.18");
    expect(div.net_amount).toBe("36.82");

    // Nothing left to do on the second pass.
    const again = await enrichPendingDocuments([depot]);
    expect(again.documents_examined).toBe(0);
  });

  it("the enrich endpoint requires write access", async () => {
    const { depot } = await setup();
    await insertDocument(BUY_TEXT);
    await ensureUser(5);
    await db.insert(financeAccountAccess).values({ account_id: depot, user_id: 5, level: "read" });
    setAuth("5", ["finance.view"]);
    await expect(enrichDepotTransactionsFromDocuments({})).rejects.toThrow(/write access/);

    await db
      .update(financeAccountAccess)
      .set({ level: "write" })
      .where(eq(financeAccountAccess.user_id, 5));
    const resp = await enrichDepotTransactionsFromDocuments({});
    expect(resp.created).toBe(1);
    expect(resp.results.map((r) => r.outcome)).toEqual(["created"]);
  });
});

describe("finance/portfolio — review and apply", () => {
  it("lists conflicts and unmatched documents without writing, and resolves a conflict on apply", async () => {
    const { bc, giro, depot } = await setup();
    await insertGiroBooking(giro, "2026-03-16", "-2900.00");
    await deriveDepotTransactionsForBankcontact(bc);
    const conflictDoc = await insertDocument(BUY_TEXT);
    const foreignDoc = await insertDocument(BUY_TEXT.replace(ISIN_A, "DE000000ZZZ9"));

    const review = await getPortfolioReview({});
    expect(review.conflicts).toHaveLength(1);
    expect(review.conflicts[0]).toMatchObject({
      document_id: conflictDoc,
      account_id: depot,
      kind: "buy",
      statement_net: "-2966.40",
      transaction_net: "-2900.00",
    });
    expect(review.unmatched_documents.map((d) => d.document_id)).toEqual([foreignDoc]);
    // The dry run changed nothing.
    const [row] = await depotRows(depot);
    expect(row!.net_amount).toBe("-2900.00");
    expect(row!.amount).toBeNull();

    const applied = await applySettlementDocument({ documentId: conflictDoc });
    expect(applied.outcome).toBe("enriched");
    const [after] = await depotRows(depot);
    expect(after!.net_amount).toBe("-2966.40");
    expect(Number(after!.amount)).toBe(25);
    expect(after!.source).toBe("giro-derived+document");
    // The booking's date stays.
    expect(after!.executed_at.slice(0, 10)).toBe("2026-03-16");

    const again = await getPortfolioReview({});
    expect(again.conflicts).toEqual([]);
  });

  it("hides another user's documents from the review", async () => {
    const { bc, giro, depot } = await setup();
    await insertGiroBooking(giro, "2026-03-16", "-2900.00");
    await deriveDepotTransactionsForBankcontact(bc);
    await insertDocument(BUY_TEXT); // owned by user 1
    await ensureUser(6);
    await db.insert(financeAccountAccess).values({ account_id: depot, user_id: 6, level: "write" });
    setAuth("6", ["finance.view"]);
    const review = await getPortfolioReview({});
    expect(review.conflicts).toEqual([]);
    expect(review.unmatched_documents).toEqual([]);
  });

  it("reports holding gaps on the review and the position", async () => {
    const { depot } = await setup(); // snapshot 2026-03-01: 25 shares
    await db.insert(financeAccountHolding).values({
      account_id: depot,
      as_of: "2026-04-01",
      isin: ISIN_A,
      name: "Alpha Industries AG",
      amount: "40",
      price: "120.00",
      value: "4800.00",
      currency: "EUR",
    });
    // 25 → 40 with only 10 bought: 5 unexplained.
    await db.insert(financeDepotTransaction).values({
      account_id: depot,
      isin: ISIN_A,
      name: "Alpha Industries AG",
      kind: "buy",
      executed_at: "2026-03-10",
      amount: "10",
      price: "118.00",
      net_amount: "-1180.00",
      currency: "EUR",
      source: "manual",
    });

    const review = await getPortfolioReview({});
    expect(review.holding_gaps).toHaveLength(1);
    expect(review.holding_gaps[0]).toMatchObject({
      account_id: depot,
      account_label: "Depot",
      position_key: ISIN_A,
      name: "Alpha Industries AG",
      from: "2026-03-01",
      to: "2026-04-01",
      unexplained: "5.00000000",
    });

    const pos = await getPortfolioPosition({ key: ISIN_A });
    expect(pos.holding_gaps.map((g) => g.unexplained)).toEqual(["5.00000000"]);
    expect(pos.unverifiable_changes).toBe(0);
  });
});

describe("finance/depot-document-enrichment — finding the depot without a holding", () => {
  // A position sold before the first sync: no snapshot holds DE000000SLD3.
  const SOLD_ISIN = "DE000000SLD3";
  const soldText = (depotLine: string) => `Beispielbank AG
Wertpapierabrechnung Verkauf
${depotLine}
Stück 5
Beta Altbestand AG
ISIN ${SOLD_ISIN}
Schlusstag 10.02.2021
Kurs 20,00 EUR
Kurswert 100,00 EUR
Ausmachender Betrag 100,00 EUR`;

  async function setDepotNumber(depot: number, number: string) {
    await db.update(financeAccount).set({ account_number: number }).where(eq(financeAccount.id, depot));
  }

  it("uses the depot number printed on the statement", async () => {
    const { depot } = await setup();
    await setDepotNumber(depot, "0012345678");
    const docId = await insertDocument(soldText("Depotnummer 12345678"));
    const r = await enrichDocument(docId);
    expect(r.outcome).toBe("created");
    expect(r.account_id).toBe(depot);
    const rows = await depotRows(depot);
    expect(rows.map((x) => [x.isin, x.kind, x.name])).toEqual([[SOLD_ISIN, "sell", "Beta Altbestand AG"]]);
  });

  it("uses the one depot that already has transactions of the security", async () => {
    const { depot } = await setup();
    await db.insert(financeDepotTransaction).values({
      account_id: depot,
      isin: SOLD_ISIN,
      kind: "buy",
      executed_at: "2020-01-15",
      amount: "5",
      price: "15.00",
      net_amount: "-75.00",
      currency: "EUR",
      source: "manual",
    });
    const docId = await insertDocument(soldText(""));
    const r = await enrichDocument(docId);
    expect(r.outcome).toBe("created");
    expect(r.account_id).toBe(depot);
  });

  it("does not guess between two depots with a matching number, and says why in the review", async () => {
    const { bc, depot } = await setup();
    const [other] = await db
      .insert(financeAccount)
      .values({
        bankcontact_id: bc,
        type_id: (await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, "depot")).limit(1))[0]!.id,
        currency_code: "EUR",
        account_number: "depot-2",
        label: "Depot 2",
      })
      .returning({ id: financeAccount.id });
    await setDepotNumber(depot, "1234567801");
    await setDepotNumber(other!.id, "1234567802");
    const docId = await insertDocument(soldText("Depotnummer 12345678"));

    const r = await enrichDocument(docId);
    expect(r.outcome).toBe("no_holding");
    expect(r.isin).toBe(SOLD_ISIN);
    expect(r.depot_number).toBe("12345678");

    const review = await getPortfolioReview({});
    expect(review.unmatched_documents).toEqual([
      expect.objectContaining({ document_id: docId, isin: SOLD_ISIN, wkn: null, depot_number: "12345678" }),
    ]);
  });
});

describe("finance/portfolio — depots without any data", () => {
  it("are left out of the depot list and the scope", async () => {
    const { bc, depot } = await setup();
    await db.insert(financeAccount).values({
      bankcontact_id: bc,
      type_id: (await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, "depot")).limit(1))[0]!.id,
      currency_code: "EUR",
      account_number: "empty-sub-depot",
      label: "Leeres Unterdepot",
    });
    const resp = await getPortfolio({});
    expect(resp.accounts.map((a) => a.id)).toEqual([depot]);
  });
});

describe("finance/portfolio — document inspection", () => {
  it("reports every field, the labels read, the depot a dry run picks and how", async () => {
    const { depot } = await setup();
    const docId = await insertDocument(BUY_TEXT);

    const before = await inspectSettlementDocument({ documentId: docId });
    expect(before.method).toBe("rules");
    expect(before.llm_fallback_used).toBe(false);
    expect(before.is_settlement).toBe(true);
    expect(before.rejection).toBeNull();
    expect(before.fields).toMatchObject({
      kind: "buy",
      isin: ISIN_A,
      executed_at: "2026-03-14",
      quantity: "25.00000000",
      price: "118.400000",
      gross: "2960.00",
      fees: "6.40",
      tax: null,
      net: "-2966.40",
      currency: "EUR",
    });
    expect(before.labels.fees).toContain("Provision");
    expect(before.labels.fees).toContain("Handelsplatzgebühr");
    expect(before.labels.executed_at).toContain("Schlusstag");
    expect(before.depot).toMatchObject({
      outcome: "created",
      account_id: depot,
      account_label: "Depot",
      matched_by: "holding",
      date_source: "statement",
    });
    expect(before.links).toEqual([]);

    await enrichDocument(docId);
    const after = await inspectSettlementDocument({ documentId: docId });
    expect(after.depot!.outcome).toBe("already_linked");
    expect(after.links.map((l) => [l.account_id, l.kind, l.net_amount])).toEqual([[depot, "buy", "-2966.40"]]);
  });

  it("says why a text is not a settlement, and hides other users' documents", async () => {
    await setup();
    const invoice = await insertDocument("Rechnung Nr. 1 über 120,00 EUR");
    const r = await inspectSettlementDocument({ documentId: invoice });
    expect(r.is_settlement).toBe(false);
    expect(r.rejection).toBe("no_kind");
    expect(r.depot).toBeNull();

    const noId = await insertDocument("Wertpapierabrechnung Kauf Stück 3 Schlusstag 01.02.2026 Kurswert 30,00 EUR");
    expect((await inspectSettlementDocument({ documentId: noId })).rejection).toBe("no_identifier");

    await ensureUser(8);
    setAuth("8", ["finance.view"]);
    await expect(inspectSettlementDocument({ documentId: invoice })).rejects.toThrow(/not found/);
  });
});
