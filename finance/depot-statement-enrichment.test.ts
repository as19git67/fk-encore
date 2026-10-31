import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { and, eq, sql } from "drizzle-orm";

// The language model is not reachable in tests; the cases that need it
// hand it an answer.
vi.mock("./llm-client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./llm-client")>();
  return {
    ...orig,
    extractSettlementValues: vi.fn(async () => {
      throw new orig.LlmServiceUnavailableError("not in tests");
    }),
    extractStatementPositions: vi.fn(async () => {
      throw new orig.LlmServiceUnavailableError("not in tests");
    }),
    classifySecuritiesPaper: vi.fn(async () => {
      throw new orig.LlmServiceUnavailableError("not in tests");
    }),
  };
});

import db from "../db/database";
import {
  classifySecuritiesPaper,
  extractSettlementValues,
  extractStatementPositions,
  LlmServiceUnavailableError,
} from "./llm-client";
import { classifyPendingPapers, storedPaperType } from "./depot-paper-type";
import { enrichPendingDocuments } from "./depot-document-enrichment";
import {
  documents,
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountHolding,
  financeAccountType,
  financeBankcontact,
  financeDepotDocumentIgnore,
  financeDepotSecurity,
  financeDepotTransaction,
  financeDepotTransactionDocument,
  financeDocumentStatementLlm,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  users,
} from "../db/schema";
import { enrichPendingStatements, inspectStatement, pruneStatementHoldings, readDepotStatement } from "./depot-statement-enrichment";
import { reconcileHoldings } from "./depot-holding-reconciliation";
import { admitSecurity, listSecurities, removeSecurity } from "./depot-securities";
import {
  awaitDocumentEnrichRun,
  decideDepotSecurity,
  documentEnrichRunStatus,
  getPortfolioReview,
  resetDocumentEnrichRuns,
  resetDocumentReadings,
  startDocumentEnrichRun,
} from "./portfolio";

// Synthetic identifiers and texts only — see CLAUDE.md "Keine PII".
const ISIN_A = "DE000000AAA1";
const ISIN_B = "LU000000BBB4";
const DEPOT_NUMBER = "9900000002";

const STATEMENT_WITH_NUMBER = `Beispielbank AG
Depotauszug per 31.12.2025
Depot-Nr. ${DEPOT_NUMBER}

Alpha Industries AG
ISIN ${ISIN_A}
Stück 20 Kurs 110,00 EUR Kurswert 2.200,00 EUR

Beta Global Fonds
ISIN ${ISIN_B}
Stück 10,5 Kurs 95,20 EUR Kurswert 999,60 EUR`;

const STATEMENT_WITHOUT_NUMBER = `Beispielbank AG
Vermögensübersicht
Stand: 30.09.2025

Alpha Industries AG
ISIN ${ISIN_A}
Stück 15 Kurs 100,00 EUR Kurswert 1.500,00 EUR`;

const STATEMENT_UNKNOWN_ONLY = `Beispielbank AG
Depotauszug per 30.06.2025

Beta Global Fonds
ISIN ${ISIN_B}
Stück 8 Kurs 90,00 EUR Kurswert 720,00 EUR`;

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
  await db.delete(financeDepotDocumentIgnore);
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
  resetDocumentEnrichRuns();
  for (const fn of [extractStatementPositions, classifySecuritiesPaper, extractSettlementValues]) {
    vi.mocked(fn).mockReset();
    vi.mocked(fn).mockImplementation(async () => {
      throw new LlmServiceUnavailableError("not in tests");
    });
  }
  setAuth("1", ["finance.view", "finance.admin"]);
});

/** A bankcontact with one depot that holds Alpha (confirmed by the bank) on 2026-03-01. */
async function setup(opts: { depotNumber?: string | null } = {}): Promise<{ bc: number; depot: number }> {
  const [bcRow] = await db
    .insert(financeBankcontact)
    .values({ name: "Test", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  const typeId = async (kind: "depot" | "giro") =>
    (await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, kind)).limit(1))[0]!.id;
  const [depot] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bcRow!.id,
      type_id: await typeId("depot"),
      currency_code: "EUR",
      // "depot-x": no five digits, so no statement's depot number matches it.
      account_number: opts.depotNumber === undefined ? DEPOT_NUMBER : (opts.depotNumber ?? "depot-x"),
      label: "Depot",
    })
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
  await admitSecurity(depot!.id, { isin: ISIN_A, wkn: null, name: "Alpha Industries AG" }, "bank");
  // The portfolio covers the caller's own depots (a `write` entry); the
  // default caller, user 1, owns them.
  await ensureUser(1);
  await db.insert(financeAccountAccess).values({ account_id: depot!.id, user_id: 1, level: "write" });
  return { bc: bcRow!.id, depot: depot!.id };
}

let docCounter = 0;
async function insertDocument(text: string, opts: { userId?: number; docDate?: string } = {}): Promise<number> {
  docCounter += 1;
  const name = `statement-${docCounter}-${Math.random().toString(36).slice(2)}`;
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
      status: "ready",
      extracted_text: text,
      doc_date: opts.docDate ?? null,
    })
    .returning({ id: documents.id });
  return row!.id;
}

async function holdingsOf(depot: number) {
  return db
    .select()
    .from(financeAccountHolding)
    .where(eq(financeAccountHolding.account_id, depot))
    .orderBy(financeAccountHolding.as_of, financeAccountHolding.id);
}

describe("finance/depot-statement-enrichment", () => {
  it("stores the confirmed positions of a statement with the depot number and proposes the unknown one", async () => {
    const { depot } = await setup();
    const docId = await insertDocument(STATEMENT_WITH_NUMBER);

    const r = await readDepotStatement(docId);
    expect(r.outcome).toBe("stored");
    expect(r.account_id).toBe(depot);
    expect(r.matched_by).toBe("depot_number");
    expect(r.as_of).toBe("2025-12-31");
    expect(r.positions_found).toBe(2);
    expect(r.positions_stored).toBe(1);
    expect(r.positions_proposed).toBe(1);
    expect(r.llm_status).toBe("unavailable");

    const rows = await holdingsOf(depot);
    expect(rows).toHaveLength(2);
    const stored = rows[0]!;
    expect(stored.as_of.slice(0, 10)).toBe("2025-12-31");
    expect(stored.isin).toBe(ISIN_A);
    expect(stored.source).toBe("document");
    expect(stored.document_id).toBe(docId);
    expect(Number(stored.amount)).toBe(20);
    expect(stored.price).toBe("110.000000");
    expect(stored.value).toBe("2200.00");
    // The bank's row of a later day is untouched.
    expect(rows[1]!.source).toBe("bank");

    // Beta is a proposal with the statement as evidence.
    const proposed = await listSecurities([depot], ["proposed"]);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ isin: ISIN_B, documents: 1, document_ids: [docId] });

    // A second read changes nothing.
    const again = await readDepotStatement(docId);
    expect(again.outcome).toBe("already_stored");
    expect(await holdingsOf(depot)).toHaveLength(2);
  });

  it("shows which listed positions went into the holdings of the paper's day", async () => {
    const { depot } = await setup();
    const docId = await insertDocument(STATEMENT_WITH_NUMBER);
    await readDepotStatement(docId);
    // A row the reading stored, removed again: the paper lists it, the day misses it.
    await db.delete(financeAccountHolding).where(and(eq(financeAccountHolding.document_id, docId), eq(financeAccountHolding.isin, ISIN_A)));

    const view = (await inspectStatement(docId, STATEMENT_WITH_NUMBER, [depot]))!;
    expect(view.as_of).toBe("2025-12-31");
    expect(view.positions.map((p) => [p.isin, p.quantity, p.stored])).toEqual([
      [ISIN_A, "20.00000000", false],
      [ISIN_B, "10.50000000", false],
    ]);
    expect(view.result.outcome).toBe("stored");
    expect(view.result.positions_proposed).toBe(1);

    await readDepotStatement(docId);
    const again = (await inspectStatement(docId, STATEMENT_WITH_NUMBER, [depot]))!;
    expect(again.positions.find((p) => p.isin === ISIN_A)!.stored).toBe(true);
    expect(again.stored_only).toEqual([]);
  });

  it("names a position whose security the user took out of the depot", async () => {
    const { depot } = await setup();
    const docId = await insertDocument(STATEMENT_WITH_NUMBER);
    await readDepotStatement(docId);
    await removeSecurity(depot, { isin: ISIN_B, wkn: null, name: null }, 1);

    const view = (await inspectStatement(docId, STATEMENT_WITH_NUMBER, [depot]))!;
    expect(view.positions.map((p) => [p.isin, p.stored, p.security_status])).toEqual([
      [ISIN_A, true, "confirmed"],
      [ISIN_B, false, "ignored"],
    ]);
  });

  it("has nothing to show for a paper that is no statement", async () => {
    const { depot } = await setup();
    const text = "Wertpapierabrechnung Kauf\nISIN DE000000AAA1\nStück 1 Kurs 10,00 EUR\nKurswert 10,00 EUR\nAusmachender Betrag 10,00 EUR";
    const docId = await insertDocument(text);
    expect(await inspectStatement(docId, text, [depot])).toBeNull();
  });

  it("finds the depot through its securities master when no depot number is printed", async () => {
    const { depot } = await setup({ depotNumber: null });
    const docId = await insertDocument(STATEMENT_WITHOUT_NUMBER);

    const r = await readDepotStatement(docId);
    expect(r.outcome).toBe("stored");
    expect(r.matched_by).toBe("securities");
    expect(r.as_of).toBe("2025-09-30");
    const rows = await holdingsOf(depot);
    expect(rows[0]).toMatchObject({ isin: ISIN_A, source: "document" });
    expect(Number(rows[0]!.amount)).toBe(15);
  });

  it("leaves a statement unplaced when no depot knows any of its securities, and lists it on the review page", async () => {
    await setup({ depotNumber: null });
    const docId = await insertDocument(STATEMENT_UNKNOWN_ONLY);

    const r = await readDepotStatement(docId);
    expect(r.outcome).toBe("no_depot");
    expect(r.identifiers).toEqual([ISIN_B]);
    expect(await db.select().from(financeAccountHolding).where(eq(financeAccountHolding.source, "document"))).toHaveLength(0);

    const review = await getPortfolioReview({});
    expect(review.unplaced_statements).toHaveLength(1);
    expect(review.unplaced_statements[0]).toMatchObject({
      document_id: docId,
      as_of: "2025-06-30",
      depot_number: null,
      positions: 1,
      identifiers: [ISIN_B],
      ignored: false,
    });
    // Nothing is proposed by a dry run.
    expect(await db.select().from(financeDepotSecurity).where(eq(financeDepotSecurity.isin, ISIN_B))).toHaveLength(0);
  });

  it("stores the position once the user takes the proposed security in", async () => {
    const { depot } = await setup();
    const docId = await insertDocument(STATEMENT_WITH_NUMBER);
    await readDepotStatement(docId);
    const [sec] = await listSecurities([depot], ["proposed"]);

    const decided = await decideDepotSecurity({ securityId: sec!.id, decision: "confirm" });
    expect(decided.status).toBe("confirmed");
    expect(decided.documents_read).toBe(1);
    const rows = await holdingsOf(depot);
    const beta = rows.find((h) => h.isin === ISIN_B);
    expect(beta).toBeDefined();
    expect(beta!.source).toBe("document");
    expect(Number(beta!.amount)).toBe(10.5);

    // Ignoring it again removes what the statement wrote for it.
    await decideDepotSecurity({ securityId: sec!.id, decision: "ignore" });
    expect((await holdingsOf(depot)).find((h) => h.isin === ISIN_B)).toBeUndefined();
  });

  it("takes the model's positions first and keeps its answer", async () => {
    const { depot } = await setup();
    // A layout the rules cannot read: figures in columns the labels do not reach.
    const text = `Beispielbank AG
Depotbestand per 30.11.2025
Depot ${DEPOT_NUMBER}
Alpha Industries AG ${ISIN_A}
22 | 105,00 | 2.310,00`;
    const docId = await insertDocument(text);
    vi.mocked(extractStatementPositions).mockResolvedValueOnce({
      is_statement: true,
      as_of: "2025-11-30",
      positions: [{ isin: ISIN_A, name: "Alpha Industries AG", quantity: 22, price: 105, value: 2310, currency: "EUR" }],
    });

    const r = await readDepotStatement(docId);
    expect(r.outcome).toBe("stored");
    expect(r.llm_status).toBe("used");
    const [row] = await holdingsOf(depot);
    expect(Number(row!.amount)).toBe(22);
    expect(row!.value).toBe("2310.00");
    expect(await db.select().from(financeDocumentStatementLlm).where(eq(financeDocumentStatementLlm.document_id, docId))).toHaveLength(1);
    expect(extractStatementPositions).toHaveBeenCalledTimes(1);
  });

  it("books nothing when the model says the paper is something else", async () => {
    await setup();
    const docId = await insertDocument(STATEMENT_WITH_NUMBER);
    vi.mocked(extractStatementPositions).mockResolvedValueOnce({ is_statement: false, positions: [] });
    const r = await readDepotStatement(docId);
    expect(r.outcome).toBe("not_statement");
    expect(r.detail).toBe("llm_other");
  });

  it("ignores a settlement and a document marked 'ignore for depots'", async () => {
    const { depot } = await setup();
    const settlement = await insertDocument(`Wertpapierabrechnung Kauf\nDepotauszug folgt\nISIN ${ISIN_A}\nStück 5`);
    expect((await readDepotStatement(settlement)).outcome).toBe("not_statement");

    const docId = await insertDocument(STATEMENT_WITH_NUMBER);
    await db.insert(financeDepotDocumentIgnore).values({ document_id: docId, ignored_by: 1 });
    expect((await readDepotStatement(docId)).outcome).toBe("ignored");
    expect(await holdingsOf(depot)).toHaveLength(1);
  });

  it("gives the reconciliation an anchor: a change the transactions explain is no gap", async () => {
    const { depot } = await setup();
    const docId = await insertDocument(STATEMENT_WITH_NUMBER);
    await readDepotStatement(docId);
    // 20 shares on 2025-12-31, 25 on 2026-03-01: a buy of 5 in between explains it.
    await db.insert(financeDepotTransaction).values({
      account_id: depot,
      isin: ISIN_A,
      name: "Alpha Industries AG",
      kind: "buy",
      executed_at: "2026-01-15",
      amount: "5",
      price: "112.000000",
      net_amount: "-560.00",
      currency: "EUR",
      source: "manual",
    });
    const recon = await reconcileHoldings([depot]);
    expect(recon.gaps).toHaveLength(0);

    // Without the buy, the change is a gap between the statement and the bank's snapshot.
    await db.delete(financeDepotTransaction);
    const gaps = (await reconcileHoldings([depot])).gaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from: "2025-12-31", to: "2026-03-01", unexplained: "5.00000000" });
    // The stand read from the statement names it; the bank's sync names none.
    expect(gaps[0]).toMatchObject({ from_document_id: docId, to_document_id: null });
  });

  it("reads pending statements in the background run and skips those stored already", async () => {
    const { depot } = await setup();
    const stored = await insertDocument(STATEMENT_WITH_NUMBER);
    await readDepotStatement(stored);
    const pending = await insertDocument(STATEMENT_WITHOUT_NUMBER);
    const unplaced = await insertDocument(STATEMENT_UNKNOWN_ONLY);

    const stats = await enrichPendingStatements([depot]);
    expect(stats.documents_examined).toBe(2);
    expect(stats.stored).toBe(1);
    expect(stats.no_depot).toBe(1);
    expect(stats.results.map((r) => r.document_id).sort()).toEqual([pending, unplaced].sort());

    // The server-side run counts the statements too.
    await db.delete(financeAccountHolding).where(and(eq(financeAccountHolding.source, "document"), eq(financeAccountHolding.document_id, pending)));
    await startDocumentEnrichRun({});
    await awaitDocumentEnrichRun(1);
    const { run } = await documentEnrichRunStatus();
    expect(run!.status).toBe("done");
    expect(run!.totals.statements_stored).toBe(1);
    expect(run!.totals.statements_unplaced).toBe(1);
  });

  it("reads a report's holdings table with WKNs only, placing it by the names the master knows", async () => {
    // The master knows Alpha by its ISIN alone (the bank's sync delivered no WKN).
    const { depot } = await setup({ depotNumber: null });
    const docId = await insertDocument(`Finanzreport Nr. 9 per 01.04.2026
Depotbestand EUR EUR EUR
WKN / Verwahrart Anzahl / Nominal letzter Währung Kurswert Kaufwert Gewinn / Verlust
Bezeichnung Kurs Stückzinsen
AAA111 / Girosammelverwahrung 25,000 118,400 EUR 2.960,00 2.500,00 +460,00
ALPHA INDUSTRIES AG NA O.N. +0,00
BBB222 / Girosammelverwahrung 100,000 12,500 EUR 1.250,00 1.400,00 -150,00
BETA GLOBAL AG +0,00`);

    const r = await readDepotStatement(docId);
    expect(r.outcome).toBe("stored");
    expect(r.matched_by).toBe("securities");
    expect(r.positions_stored).toBe(1);
    expect(r.positions_proposed).toBe(1);
    const row = (await holdingsOf(depot)).find((h) => h.document_id === docId)!;
    // Keyed like the bank's rows: under the ISIN the master knows.
    expect(row).toMatchObject({ isin: ISIN_A, wkn: "AAA111", source: "document" });
    expect(Number(row.amount)).toBe(25);
    expect(row.acquisition_price).toBe("100.000000");
    // The master learnt the WKN; Beta is a proposal, not a second Alpha.
    const [alpha] = await db.select().from(financeDepotSecurity).where(eq(financeDepotSecurity.isin, ISIN_A));
    expect(alpha!.wkn).toBe("AAA111");
    const proposed = await listSecurities([depot], ["proposed"]);
    expect(proposed.map((s) => s.wkn)).toEqual(["BBB222"]);
  });

  it("stores only what a report's holdings table lists, not a security its trade list names", async () => {
    const { depot } = await setup({ depotNumber: null });
    // Gamma was sold before the report's day: the report lists the sale, its table no longer the security.
    const ISIN_C = "DE000EEE5559";
    await admitSecurity(depot, { isin: ISIN_C, wkn: "EEE555", name: "Gamma Werke AG" }, "bank");
    const text = `Finanzreport Nr. 2 per 01.02.2026
Umsätze
12.01.2026 Wertpapierverkauf WKN EEE555 ISIN ${ISIN_C} Stück 3
Depotbestand EUR EUR EUR
WKN / Verwahrart Anzahl / Nominal letzter Währung Kurswert Kaufwert Gewinn / Verlust
AAA111 / Girosammelverwahrung 25,000 118,400 EUR 2.960,00 2.500,00 +460,00
ALPHA INDUSTRIES AG NA O.N. +0,00`;
    const docId = await insertDocument(text);
    // The model lists the sold security too, with a quantity from elsewhere on the page.
    vi.mocked(extractStatementPositions).mockResolvedValueOnce({
      is_statement: true,
      as_of: "2026-02-01",
      positions: [
        { wkn: "AAA111", name: "Alpha Industries AG", quantity: 25, price: 118.4, value: 2960, currency: "EUR" },
        { isin: ISIN_C, name: "Gamma Werke AG", quantity: 7, currency: "EUR" },
      ],
    });

    const r = await readDepotStatement(docId);
    expect(r.outcome).toBe("stored");
    expect(r.positions_stored).toBe(1);
    const rows = (await holdingsOf(depot)).filter((h) => h.document_id === docId);
    expect(rows.map((h) => h.wkn)).toEqual(["AAA111"]);

    // A row an earlier reading wrote from the trade list goes; the table's stays.
    await db.insert(financeAccountHolding).values({
      account_id: depot,
      as_of: "2026-02-01",
      isin: ISIN_C,
      name: "Gamma Werke AG",
      amount: "7",
      currency: "EUR",
      source: "document",
      document_id: docId,
    });
    expect(await pruneStatementHoldings([depot])).toBe(1);
    const left = (await holdingsOf(depot)).filter((h) => h.document_id === docId);
    expect(left.map((h) => h.wkn)).toEqual(["AAA111"]);
    // Nothing more to drop the second time; other statements are untouched.
    expect(await pruneStatementHoldings([depot])).toBe(0);
  });

  it("asks the model once about a paper the rules do not recognise and reads it as the kind it names", async () => {
    const { depot } = await setup();
    // No heading the rules know: neither "Depotauszug" nor "Wertpapierabrechnung".
    const overview = await insertDocument(`Beispielbank AG
Übersicht Ihrer Anlagen zum Stichtag
Stand: 30.09.2025
Depot ${DEPOT_NUMBER}
Alpha Industries AG ISIN ${ISIN_A}
Anteile 15 Kurs 100,00 EUR Kurswert 1.500,00 EUR`);
    const order = await insertDocument(`Beispielbank AG
Ihre Order wurde ausgeführt
Alpha Industries AG ISIN ${ISIN_A}
Anteile 5 zu 112,00 EUR
Belastung 565,00 EUR`);
    const letter = await insertDocument(`Beispielbank AG
Information zu Ihrem Fonds Alpha Industries AG ISIN ${ISIN_A}
Wir informieren Sie über die neue Anteilklasse.`);
    vi.mocked(classifySecuritiesPaper).mockImplementation(async (text: string) => ({
      paper_type: text.includes("Übersicht") ? "statement" : text.includes("Order") ? "trade" : "other",
    }));

    const stats = await classifyPendingPapers();
    expect(stats).toMatchObject({ documents_examined: 3, statements: 1, settlements: 1, other: 1, unanswered: 0 });
    expect(await storedPaperType(overview)).toBe("statement");
    expect(await storedPaperType(letter)).toBe("other");
    // Asked once: a second run finds nothing left to ask.
    expect((await classifyPendingPapers()).documents_examined).toBe(0);
    expect(classifySecuritiesPaper).toHaveBeenCalledTimes(3);

    // The statement reader takes the overview.
    const statements = await enrichPendingStatements([depot]);
    expect(statements.results.map((r) => r.document_id)).toEqual([overview]);
    expect(statements.stored).toBe(1);
    const rows = await holdingsOf(depot);
    expect(rows.find((h) => h.document_id === overview)).toMatchObject({ isin: ISIN_A, source: "document" });

    // The settlement reader takes the order confirmation — and only it.
    vi.mocked(extractSettlementValues).mockResolvedValueOnce({
      is_settlement: true,
      kind: "buy",
      isin: ISIN_A,
      executed_at: "2026-01-15",
      quantity: 5,
      price: 112,
      gross: 560,
      fees: 5,
      net: 565,
      currency: "EUR",
    });
    const settlements = await enrichPendingDocuments([depot]);
    expect(settlements.results.map((r) => r.document_id)).toEqual([order]);
    expect(settlements.created).toBe(1);
  });

  it("'read again' removes what statements wrote and clears their model answers", async () => {
    const { depot } = await setup();
    const docId = await insertDocument(STATEMENT_WITH_NUMBER);
    vi.mocked(extractStatementPositions).mockResolvedValueOnce({
      is_statement: true,
      as_of: "2025-12-31",
      positions: [{ isin: ISIN_A, quantity: 20, price: 110, value: 2200 }],
    });
    await readDepotStatement(docId);
    expect(await holdingsOf(depot)).toHaveLength(2);

    const r = await resetDocumentReadings({});
    expect(r.holdings_removed).toBe(1);
    expect(r.answers_cleared).toBe(1);
    const rows = await holdingsOf(depot);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("bank");
  });
});
