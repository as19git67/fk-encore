/**
 * Documents as the primary source for depot transactions (#1336, stage 4).
 *
 * A giro booking knows "−2.966,40 € to the depot"; the settlement the
 * broker sent knows 25 shares at 118,40, a 4,90 commission and the day it
 * was executed. This module reads the settlement (depot-settlement-parser)
 * and folds it into `finance_depot_transaction`:
 *
 *   1. find the depot that holds the security (ISIN or WKN in any
 *      snapshot of the depots in scope — the most recent wins),
 *   2. find an existing row of the same position and kind within ±7 days
 *      whose net amount agrees (or carries no net at all): the giro-derived
 *      row, typically. Fill in what it lacks — quantity, price, gross,
 *      fees, taxes — and link the document. Nothing a row already carries
 *      is overwritten; a document that disagrees with the booking is
 *      reported, not applied,
 *   3. otherwise create the row with `source='document'` and
 *      `dedupe_hash='doc:<id>'`, so a second run is a no-op.
 *
 * `enrichDocument` runs after a document is classified (hook in
 * documents/document-ops.ts) and `enrichPendingDocuments` on demand for a
 * set of depots, e.g. after a backfill of old statements.
 */

import { and, desc, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";

import db from "../db/database";
import {
  documents,
  financeAccount,
  financeDepotDocumentIgnore,
  financeAccountAccess,
  financeAccountHolding,
  financeAccountType,
  financeDepotTransaction,
  financeDepotTransactionDocument,
} from "../db/schema";
import {
  INSURANCE_PATTERN,
  isUsableSettlement,
  SETTLEMENT_CANDIDATE_PATTERN,
  STRONG_SETTLEMENT_PATTERN,
  type SettlementExtraction,
} from "./depot-settlement-parser";
import type { SettlementValues } from "./depot-settlement-merge";
import {
  readSettlement,
  rereadAgainstBooking,
  rejectedAsOtherPaper,
  type LlmMode,
  type LlmStatus,
  type SettlementReading,
} from "./depot-settlement-reader";

console.log("[boot] finance/depot-document-enrichment.ts: all imports resolved");

/** Days around the settlement date a booking may sit. Same window as the receipt matcher. */
export const SETTLEMENT_MATCH_WINDOW_DAYS = 7;
/** Cents of tolerance between the net on the statement and the net on the booking. */
const NET_TOLERANCE = 0.011;

export type EnrichOutcome =
  | "created"
  | "enriched"
  | "linked"
  | "already_linked"
  | "not_settlement"
  | "no_holding"
  | "conflict"
  /** Rules and model disagree and the figures do not settle it: nothing is booked. */
  | "unverified"
  /** A tax statement with no transaction of the same security, kind and quantity to add its tax to. */
  | "no_transaction";

export interface EnrichResult {
  document_id: number;
  outcome: EnrichOutcome;
  depot_transaction_id: number | null;
  account_id: number | null;
  /** For `conflict`: what the statement says vs. what the row carries. */
  detail: string | null;
  /** Net amount read from the statement (scale 2, signed), when one was read. */
  statement_net: string | null;
  /** Net amount of the matched row, for `conflict` and `enriched`/`linked`. */
  transaction_net: string | null;
  /** What the statement identified itself by — the reason when no depot matched. */
  isin: string | null;
  wkn: string | null;
  depot_number: string | null;
  /** How the depot was found; null when none was. */
  matched_by: DepotMatchedBy | null;
  /** Where the execution date came from: the statement itself or the document's date. */
  date_source: "statement" | "document_date" | null;
  /** What happened with the language model for this read. */
  llm_status: LlmStatus | null;
  /** Rules and model disagreed and the booking's net decided between them. */
  checked_against_booking: boolean;
  /** The user marked the document "ignore for depots". */
  ignored: boolean;
  /** The document is a tax statement on its own: it only adds the tax to an existing transaction. */
  tax_statement: boolean;
}

export interface EnrichOptions {
  /** Report what would happen without writing anything. */
  dryRun?: boolean;
  /**
   * Resolve a conflict in the statement's favour: write every value the
   * statement carries onto the matched row (the booking's date stays) and
   * link the document. Only takes effect when the outcome would be
   * `conflict`; the user asked for it after looking at both numbers.
   */
  overwrite?: boolean;
  /**
   * Whether the language model may be asked (see depot-settlement-reader).
   * Defaults to "cache-only" for a dry run and "allow" otherwise.
   */
  llm?: LlmMode;
  /**
   * Read documents the user marked "ignore for depots" as well (the review
   * page with "show ignored" on). Never combined with writing: an ignored
   * document is only ever looked at.
   */
  includeIgnored?: boolean;
}

export interface EnrichStats {
  documents_examined: number;
  created: number;
  enriched: number;
  linked: number;
  already_linked: number;
  skipped_not_settlement: number;
  skipped_no_holding: number;
  conflicts: number;
  /** Rules and model disagreed and the figures did not settle it. */
  unverified: number;
  /** Tax statements without a transaction to add their tax to. */
  skipped_no_transaction: number;
  errors: string[];
  results: EnrichResult[];
  /** Where the next page starts (`before` of the next call); null when this was the last. */
  next_before: number | null;
}

function emptyStats(): EnrichStats {
  return {
    next_before: null,
    documents_examined: 0,
    created: 0,
    enriched: 0,
    linked: 0,
    already_linked: 0,
    skipped_not_settlement: 0,
    skipped_no_holding: 0,
    conflicts: 0,
    unverified: 0,
    skipped_no_transaction: 0,
    errors: [],
    results: [],
  };
}

/** How a statement found its depot. */
export type DepotMatchedBy = "holding" | "depot_number" | "transactions";

interface HoldingMatch {
  account_id: number;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  currency: string | null;
  via: DepotMatchedBy;
}

/**
 * The depot that holds the security, among `accountIds` (or every depot
 * when null). ISIN first, then WKN; the newest snapshot breaks ties.
 */
async function findHoldingDepot(
  s: SettlementExtraction,
  accountIds: number[] | null,
): Promise<Omit<HoldingMatch, "via"> | null> {
  const idMatches = [];
  if (s.isin) idMatches.push(eq(financeAccountHolding.isin, s.isin));
  if (s.wkn) idMatches.push(eq(financeAccountHolding.wkn, s.wkn));
  if (idMatches.length === 0) return null;

  const conditions = [eq(financeAccountType.kind, "depot"), or(...idMatches)!];
  if (accountIds) {
    if (accountIds.length === 0) return null;
    conditions.push(inArray(financeAccountHolding.account_id, accountIds));
  }

  const [row] = await db
    .select({
      account_id: financeAccountHolding.account_id,
      isin: financeAccountHolding.isin,
      wkn: financeAccountHolding.wkn,
      name: financeAccountHolding.name,
      currency: financeAccountHolding.currency,
    })
    .from(financeAccountHolding)
    .innerJoin(financeAccount, eq(financeAccount.id, financeAccountHolding.account_id))
    .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id))
    .where(and(...conditions))
    .orderBy(desc(financeAccountHolding.as_of))
    .limit(1);
  return row ?? null;
}

function digitsOnly(raw: string | null): string {
  return (raw ?? "").replace(/\D/g, "");
}

/**
 * The depot whose number the statement prints. Banks pad or shorten the
 * number on paper ("0012345678" vs. "12345678", or a sub-depot suffix), so
 * one number ending with the other counts, as long as the shorter one has
 * at least five digits.
 */
async function findDepotByNumber(
  depotNumber: string,
  accountIds: number[] | null,
): Promise<number | null> {
  const conditions = [eq(financeAccountType.kind, "depot")];
  if (accountIds) {
    if (accountIds.length === 0) return null;
    conditions.push(inArray(financeAccount.id, accountIds));
  }
  const rows = await db
    .select({
      id: financeAccount.id,
      account_number: financeAccount.account_number,
      fints_account_number: financeAccount.fints_account_number,
    })
    .from(financeAccount)
    .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id))
    .where(and(...conditions));
  const matches = rows.filter((r) =>
    [digitsOnly(r.account_number), digitsOnly(r.fints_account_number)].some((n) => {
      if (n.length < 5) return false;
      const [short, long] = n.length <= depotNumber.length ? [n, depotNumber] : [depotNumber, n];
      return long.endsWith(short) || long.startsWith(short);
    }),
  );
  // Ambiguous → no guess.
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * The depot that already has transactions of this security — a position
 * sold before the first sync still has its giro-derived or earlier
 * document rows. Only when exactly one depot qualifies.
 */
async function findDepotByTransactions(
  s: SettlementExtraction,
  accountIds: number[] | null,
): Promise<number | null> {
  const idMatches = [];
  if (s.isin) idMatches.push(eq(financeDepotTransaction.isin, s.isin));
  if (s.wkn) idMatches.push(eq(financeDepotTransaction.wkn, s.wkn));
  if (idMatches.length === 0) return null;
  const conditions = [or(...idMatches)!];
  if (accountIds) {
    if (accountIds.length === 0) return null;
    conditions.push(inArray(financeDepotTransaction.account_id, accountIds));
  }
  const rows = await db
    .selectDistinct({ account_id: financeDepotTransaction.account_id })
    .from(financeDepotTransaction)
    .where(and(...conditions));
  return rows.length === 1 ? rows[0]!.account_id : null;
}

/**
 * Where a statement belongs: the depot holding the security, else the
 * depot whose number it prints, else the one depot that already has
 * transactions of the security.
 */
async function resolveDepot(
  s: SettlementExtraction,
  accountIds: number[] | null,
): Promise<HoldingMatch | null> {
  const byHolding = await findHoldingDepot(s, accountIds);
  if (byHolding) return { ...byHolding, via: "holding" };
  const fallback = (account_id: number, via: DepotMatchedBy): HoldingMatch => ({
    account_id,
    isin: s.isin,
    wkn: s.wkn,
    name: s.name,
    currency: s.currency,
    via,
  });
  if (s.depotNumber) {
    const id = await findDepotByNumber(s.depotNumber, accountIds);
    if (id !== null) return fallback(id, "depot_number");
  }
  const byTx = await findDepotByTransactions(s, accountIds);
  return byTx === null ? null : fallback(byTx, "transactions");
}

async function accessibleAccountIds(userId: number): Promise<number[] | null> {
  const rows = await db
    .select({ account_id: financeAccountAccess.account_id })
    .from(financeAccountAccess)
    .where(eq(financeAccountAccess.user_id, userId));
  return rows.length === 0 ? null : rows.map((r) => r.account_id);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function num(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

type DepotRow = typeof financeDepotTransaction.$inferSelect;

/**
 * An existing row this statement describes: same depot, same position
 * (ISIN or WKN), same kind, executed within the window, and either the
 * same net amount or no net amount yet. The closest date wins.
 */
export async function findMatchingDepotTransaction(
  accountId: number,
  s: SettlementExtraction,
): Promise<{ row: DepotRow; netAgrees: boolean } | null> {
  if (!s.executedAt) return null;
  const idMatches = [];
  if (s.isin) idMatches.push(eq(financeDepotTransaction.isin, s.isin));
  if (s.wkn) idMatches.push(eq(financeDepotTransaction.wkn, s.wkn));

  const rows = await db
    .select()
    .from(financeDepotTransaction)
    .where(
      and(
        eq(financeDepotTransaction.account_id, accountId),
        eq(financeDepotTransaction.kind, s.kind),
        or(...idMatches)!,
        sql`${financeDepotTransaction.executed_at} >= ${shiftDate(s.executedAt, -SETTLEMENT_MATCH_WINDOW_DAYS)}::date`,
        sql`${financeDepotTransaction.executed_at} <= ${shiftDate(s.executedAt, SETTLEMENT_MATCH_WINDOW_DAYS)}::date`,
      ),
    );
  if (rows.length === 0) return null;

  const target = s.executedAt;
  const distance = (r: DepotRow) =>
    Math.abs(Date.parse(`${r.executed_at.slice(0, 10)}T00:00:00Z`) - Date.parse(`${target}T00:00:00Z`));

  const agreeing: DepotRow[] = [];
  const blank: DepotRow[] = [];
  for (const r of rows) {
    const rowNet = num(r.net_amount);
    if (rowNet === null) {
      blank.push(r);
    } else if (s.net !== null && Math.abs(Math.abs(rowNet) - Math.abs(s.net)) <= NET_TOLERANCE) {
      agreeing.push(r);
    }
  }
  const pick = (list: DepotRow[]) => list.sort((a, b) => distance(a) - distance(b))[0];
  if (agreeing.length > 0) return { row: pick(agreeing)!, netAgrees: true };
  // A row without a net, or a statement without one: nothing to disagree on.
  if (blank.length > 0) return { row: pick(blank)!, netAgrees: true };
  if (s.net === null) return { row: pick(rows)!, netAgrees: true };
  // Rows exist in the window but with a different net: a conflict to report.
  return { row: pick(rows)!, netAgrees: false };
}

/**
 * The transaction a tax statement (or a credit note awaiting one) belongs to: same depot, same position
 * (ISIN or WKN), same kind, within the window — and the same quantity
 * when both carry one. The amounts on a tax statement say nothing about
 * the row (before/after taxes, not the booked net), so they are not
 * compared. The closest date wins.
 */
export async function findTransactionByQuantity(
  accountId: number,
  s: SettlementExtraction,
): Promise<DepotRow | null> {
  if (!s.executedAt) return null;
  const idMatches = [];
  if (s.isin) idMatches.push(eq(financeDepotTransaction.isin, s.isin));
  if (s.wkn) idMatches.push(eq(financeDepotTransaction.wkn, s.wkn));
  const rows = await db
    .select()
    .from(financeDepotTransaction)
    .where(
      and(
        eq(financeDepotTransaction.account_id, accountId),
        eq(financeDepotTransaction.kind, s.kind),
        or(...idMatches)!,
        sql`${financeDepotTransaction.executed_at} >= ${shiftDate(s.executedAt, -SETTLEMENT_MATCH_WINDOW_DAYS)}::date`,
        sql`${financeDepotTransaction.executed_at} <= ${shiftDate(s.executedAt, SETTLEMENT_MATCH_WINDOW_DAYS)}::date`,
      ),
    );
  const target = Date.parse(`${s.executedAt}T00:00:00Z`);
  const distance = (r: DepotRow) => Math.abs(Date.parse(`${r.executed_at.slice(0, 10)}T00:00:00Z`) - target);
  const sameQuantity = (r: DepotRow) => {
    const amount = num(r.amount);
    return s.quantity === null || amount === null || Math.abs(Math.abs(amount) - s.quantity) < 1e-6;
  };
  return rows.filter(sameQuantity).sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

/** One document's reading, as far as it counts for a transaction it is linked to. */
interface PairReading {
  values: SettlementValues;
  taxStatement: boolean;
  taxPending: boolean;
}

async function readLinkedDocument(documentId: number): Promise<PairReading | null> {
  const [doc] = await db
    .select({ extracted_text: documents.extracted_text })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc) return null;
  const r = await readSettlement(documentId, doc.extracted_text, "cache-only");
  if (r.merge.verdict !== "ok" || rejectedAsOtherPaper(r)) return null;
  return { values: r.merge.values, taxStatement: r.rules?.taxStatement ?? false, taxPending: r.rules?.taxPending ?? false };
}

/**
 * The values a transaction takes from the documents linked to it, when one
 * of them is a tax statement or a credit note that leaves the taxes to one.
 * A bank sends two papers for one dividend: the credit note (quantity,
 * gross, withholding tax, the amount before taxes) and the tax statement
 * (the taxes withheld here, the amount after them, which is what the
 * account was credited). Together they are one transaction:
 *
 *   tax = the credit note's tax + the tax statement's
 *   net = the tax statement's amount after taxes
 *
 * Whichever is read first, the result is the same. A value a booking
 * confirmed (the net of a row matched to an account booking) and a tax the
 * row carries without a credit note to explain it are kept.
 */
export function combinePairValues(
  row: Pick<DepotRow, "amount" | "price" | "gross_amount" | "tax" | "net_amount" | "currency" | "source" | "linked_transaction_id">,
  readings: PairReading[],
): Partial<typeof financeDepotTransaction.$inferInsert> {
  const credit = readings.find((r) => !r.taxStatement)?.values ?? null;
  const creditPending = readings.find((r) => !r.taxStatement)?.taxPending ?? false;
  const statement = readings.find((r) => r.taxStatement)?.values ?? null;
  // A row only documents ever wrote: their values replace its own.
  const fromDocuments = row.source === "document" && row.linked_transaction_id === null;
  const patch: Partial<typeof financeDepotTransaction.$inferInsert> = {};
  const take = (
    key: "amount" | "price" | "gross_amount" | "currency",
    current: string | null,
    value: number | string | null,
    scale: number,
  ) => {
    if (value === null || (current !== null && !fromDocuments)) return;
    const out = typeof value === "number" ? value.toFixed(scale) : value;
    if (out !== current) patch[key] = out;
  };
  if (credit) {
    take("amount", row.amount, credit.quantity, 8);
    take("price", row.price, credit.price, 6);
    take("gross_amount", row.gross_amount, credit.gross, 2);
    take("currency", row.currency, credit.currency, 0);
  }

  let tax: number | null = null;
  if (statement?.tax != null && credit && creditPending) tax = (credit.tax ?? 0) + statement.tax;
  else if (statement?.tax != null) tax = row.tax === null ? statement.tax : null;
  else if (credit?.tax != null) tax = row.tax === null || fromDocuments ? credit.tax : null;
  if (tax !== null) {
    const out = (Math.round(tax * 100) / 100).toFixed(2);
    if (out !== row.tax) patch.tax = out;
  }

  const bookingConfirmed = row.linked_transaction_id !== null && row.net_amount !== null;
  let net: number | null = null;
  if (statement?.net != null) net = bookingConfirmed ? null : statement.net;
  else if (credit?.net != null) net = row.net_amount === null || fromDocuments ? credit.net : null;
  if (net !== null) {
    const out = net.toFixed(2);
    if (out !== row.net_amount) patch.net_amount = out;
  }
  return patch;
}

/**
 * A tax statement, or a credit note whose amount is before taxes, joins
 * the transaction of the same security, kind and quantity and links
 * itself there; the transaction then takes its values from all documents
 * linked to it (combinePairValues). The amounts are not compared to find
 * the row — the one printed is before or after taxes, not necessarily the
 * one booked. A tax statement never creates a transaction.
 */
async function joinPairTransaction(
  result: EnrichResult,
  row: DepotRow,
  documentId: number,
  dryRun: boolean,
): Promise<EnrichResult> {
  result.depot_transaction_id = row.id;
  result.transaction_net = row.net_amount;
  const linked = await db
    .select({ id: financeDepotTransactionDocument.document_id })
    .from(financeDepotTransactionDocument)
    .where(eq(financeDepotTransactionDocument.depot_transaction_id, row.id));
  const ids = [...new Set([...linked.map((l) => l.id), documentId])];
  const readings = (await Promise.all(ids.map(readLinkedDocument))).filter((r): r is PairReading => r !== null);
  const patch = combinePairValues(row, readings);
  const changed = Object.keys(patch).length > 0;
  result.outcome = changed ? "enriched" : "linked";
  if (dryRun) return result;
  if (changed) {
    await db
      .update(financeDepotTransaction)
      .set({ ...patch, source: withDocumentSource(row.source) })
      .where(eq(financeDepotTransaction.id, row.id));
  }
  await linkDocument(row.id, documentId);
  return result;
}

/** Fixed-scale string for a numeric column, or null. */
function fixed(n: number | null, scale: number): string | null {
  return n === null ? null : n.toFixed(scale);
}

async function linkDocument(depotTransactionId: number, documentId: number): Promise<void> {
  await db
    .insert(financeDepotTransactionDocument)
    .values({ depot_transaction_id: depotTransactionId, document_id: documentId })
    .onConflictDoNothing();
}

/** `giro-derived` → `giro-derived+document`; `manual` → `manual+document`; idempotent. */
function withDocumentSource(source: string): string {
  if (source === "document" || source.endsWith("+document")) return source;
  return `${source}+document`;
}

/**
 * Read one document and create or enrich the depot transaction it
 * describes. `accountIds` limits the depots considered (null = all).
 */
export async function enrichDocument(
  documentId: number,
  accountIds: number[] | null = null,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const dryRun = options.dryRun === true;
  const result: EnrichResult = {
    document_id: documentId,
    outcome: "not_settlement",
    depot_transaction_id: null,
    account_id: null,
    detail: null,
    statement_net: null,
    transaction_net: null,
    isin: null,
    wkn: null,
    depot_number: null,
    matched_by: null,
    date_source: null,
    llm_status: null,
    checked_against_booking: false,
    ignored: false,
    tax_statement: false,
  };

  const [doc] = await db
    .select({
      id: documents.id,
      user_id: documents.user_id,
      status: documents.status,
      extracted_text: documents.extracted_text,
      doc_date: documents.doc_date,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc || doc.status !== "ready") return result;

  result.ignored = await isIgnoredForDepots(documentId);
  if (result.ignored && !(options.includeIgnored && dryRun)) {
    result.detail = "ignored";
    return result;
  }

  const reading = await readSettlement(
    documentId,
    doc.extracted_text,
    options.llm ?? (dryRun ? "cache-only" : "allow"),
  );
  result.llm_status = reading.llmStatus;
  const otherPaper = rejectedAsOtherPaper(reading);
  if (otherPaper) {
    result.detail = otherPaper;
    return result;
  }
  const toParsed = (rd: SettlementReading): SettlementExtraction | null => {
    const v = rd.merge.values;
    const p: SettlementExtraction | null =
      v.kind && (v.isin || v.wkn) ? { ...v, kind: v.kind, markers: [] } : null;
    if (p && !p.executedAt && doc.doc_date) p.executedAt = doc.doc_date.slice(0, 10);
    return p;
  };
  let parsed = toParsed(reading);
  if (parsed) {
    result.date_source = reading.merge.values.executedAt ? "statement" : parsed.executedAt ? "document_date" : null;
  }
  if (!isUsableSettlement(parsed)) return result;
  result.statement_net = fixed(parsed.net, 2);
  result.isin = parsed.isin;
  result.wkn = parsed.wkn;
  result.depot_number = parsed.depotNumber;

  // Without an explicit scope, a document only reaches the depots its
  // owner has been given access to; an owner without any ACL row (an
  // admin who sees everything) reaches every depot.
  const scope = accountIds ?? (await accessibleAccountIds(doc.user_id));
  const holding = await resolveDepot(parsed, scope);
  if (!holding) {
    result.outcome = "no_holding";
    return result;
  }
  result.account_id = holding.account_id;
  result.matched_by = holding.via;

  // Already attached to a transaction of this depot: nothing to do.
  const [existingLink] = await db
    .select({ id: financeDepotTransactionDocument.depot_transaction_id })
    .from(financeDepotTransactionDocument)
    .innerJoin(
      financeDepotTransaction,
      eq(financeDepotTransaction.id, financeDepotTransactionDocument.depot_transaction_id),
    )
    .where(
      and(
        eq(financeDepotTransactionDocument.document_id, documentId),
        eq(financeDepotTransaction.account_id, holding.account_id),
      ),
    )
    .limit(1);
  if (existingLink) {
    result.outcome = "already_linked";
    result.depot_transaction_id = existingLink.id;
    return result;
  }

  // Rules and model read different figures and neither set adds up: book
  // nothing, let the user look (review page, inspection view).
  if (reading.merge.verdict === "unverified" && !options.overwrite) {
    result.outcome = "unverified";
    result.detail = reading.merge.fields
      .filter((f) => f.disagree)
      .map((f) => `${f.field}: rules ${f.rules ?? "–"} / llm ${f.llm ?? "–"}`)
      .join("; ");
    return result;
  }

  // The two papers of one dividend (or sale): the credit note before
  // taxes and the tax statement. Both join the transaction of the same
  // quantity; only the credit note may create one.
  if (reading.rules?.taxStatement || reading.rules?.taxPending) {
    result.tax_statement = reading.rules.taxStatement;
    const row = await findTransactionByQuantity(holding.account_id, parsed);
    if (row) return joinPairTransaction(result, row, documentId, dryRun);
    if (reading.rules.taxStatement) {
      result.outcome = "no_transaction";
      return result;
    }
  }

  let match = await findMatchingDepotTransaction(holding.account_id, parsed);

  // Rules and model read different charges and the statement's net does
  // not match the booking: decide again with the booking's net as a check.
  // The reading that adds up to what the bank booked is taken.
  if (match && !match.netAgrees && reading.llm && match.row.net_amount !== null) {
    const again = rereadAgainstBooking(reading, Number(match.row.net_amount));
    const p = again.merge.verdict === "ok" ? toParsed(again) : null;
    if (p && isUsableSettlement(p) && again.merge.checks.some((c) => c.name === "booking_net" && c.result === "ok")) {
      parsed = p;
      result.checked_against_booking = true;
      match = await findMatchingDepotTransaction(holding.account_id, parsed);
    }
  }

  if (match) result.transaction_net = match.row.net_amount;
  result.statement_net = fixed(parsed.net, 2);

  if (match && !match.netAgrees && !(options.overwrite && !dryRun)) {
    result.outcome = "conflict";
    result.depot_transaction_id = match.row.id;
    result.detail =
      `statement net ${parsed.net?.toFixed(2) ?? "?"} vs. transaction net ${match.row.net_amount ?? "?"} ` +
      `(${match.row.kind} ${match.row.executed_at.slice(0, 10)})`;
    return result;
  }

  if (match && !match.netAgrees) {
    // overwrite: the user chose the statement over the booking.
    const row = match.row;
    const patch: Partial<typeof financeDepotTransaction.$inferInsert> = {
      source: withDocumentSource(row.source),
    };
    if (parsed.quantity !== null) patch.amount = fixed(parsed.quantity, 8);
    if (parsed.price !== null) patch.price = fixed(parsed.price, 6);
    if (parsed.gross !== null) patch.gross_amount = fixed(parsed.gross, 2);
    if (parsed.fees !== null) patch.fees = fixed(parsed.fees, 2);
    if (parsed.tax !== null) patch.tax = fixed(parsed.tax, 2);
    if (parsed.net !== null) patch.net_amount = fixed(parsed.net, 2);
    await db.update(financeDepotTransaction).set(patch).where(eq(financeDepotTransaction.id, row.id));
    await linkDocument(row.id, documentId);
    result.outcome = "enriched";
    result.depot_transaction_id = row.id;
    return result;
  }

  if (match) {
    const row = match.row;
    const patch: Partial<typeof financeDepotTransaction.$inferInsert> = {};
    if (row.amount === null && parsed.quantity !== null) patch.amount = fixed(parsed.quantity, 8);
    if (row.price === null && parsed.price !== null) patch.price = fixed(parsed.price, 6);
    if (row.gross_amount === null && parsed.gross !== null) patch.gross_amount = fixed(parsed.gross, 2);
    if (row.fees === null && parsed.fees !== null) patch.fees = fixed(parsed.fees, 2);
    if (row.tax === null && parsed.tax !== null) patch.tax = fixed(parsed.tax, 2);
    if (row.net_amount === null && parsed.net !== null) patch.net_amount = fixed(parsed.net, 2);
    if (row.isin === null && parsed.isin) patch.isin = parsed.isin;
    if (row.wkn === null && parsed.wkn) patch.wkn = parsed.wkn;
    if (row.name === null && parsed.name) patch.name = parsed.name;
    const changed = Object.keys(patch).length > 0;
    if (dryRun) {
      result.outcome = changed ? "enriched" : "linked";
      result.depot_transaction_id = row.id;
      return result;
    }
    if (changed) patch.source = withDocumentSource(row.source);
    if (changed) {
      await db.update(financeDepotTransaction).set(patch).where(eq(financeDepotTransaction.id, row.id));
    }
    await linkDocument(row.id, documentId);
    result.outcome = changed ? "enriched" : "linked";
    result.depot_transaction_id = row.id;
    return result;
  }

  if (dryRun) {
    result.outcome = "created";
    return result;
  }

  const inserted = await db
    .insert(financeDepotTransaction)
    .values({
      account_id: holding.account_id,
      isin: parsed.isin ?? holding.isin,
      wkn: parsed.wkn ?? holding.wkn,
      name: parsed.name ?? holding.name,
      kind: parsed.kind,
      executed_at: parsed.executedAt!,
      amount: fixed(parsed.quantity, 8),
      price: fixed(parsed.price, 6),
      gross_amount: fixed(parsed.gross, 2),
      fees: fixed(parsed.fees, 2),
      tax: fixed(parsed.tax, 2),
      net_amount: fixed(parsed.net, 2),
      currency: parsed.currency ?? holding.currency,
      source: "document",
      dedupe_hash: `doc:${documentId}`,
    })
    .onConflictDoNothing({
      target: [financeDepotTransaction.account_id, financeDepotTransaction.dedupe_hash],
      where: sql`${financeDepotTransaction.dedupe_hash} IS NOT NULL`,
    })
    .returning({ id: financeDepotTransaction.id });

  const id =
    inserted[0]?.id ??
    (
      await db
        .select({ id: financeDepotTransaction.id })
        .from(financeDepotTransaction)
        .where(
          and(
            eq(financeDepotTransaction.account_id, holding.account_id),
            eq(financeDepotTransaction.dedupe_hash, `doc:${documentId}`),
          ),
        )
        .limit(1)
    )[0]?.id;
  if (id === undefined) {
    result.outcome = "not_settlement";
    result.detail = "insert produced no row";
    return result;
  }
  await linkDocument(id, documentId);
  result.outcome = inserted.length > 0 ? "created" : "already_linked";
  result.depot_transaction_id = id;
  return result;
}

/**
 * Cheap SQL pre-filter, the same words the parser uses: text that prints
 * settlement or dividend wording, unless it is insurance paperwork without
 * a word only a settlement prints (a unit-linked policy's "Ausschüttung"
 * next to its funds' ISINs). Keeping those out here matters beyond the
 * cost of reading them: they would fill the page and starve the
 * settlements behind them.
 */
const CANDIDATE_PATTERN = `(${SETTLEMENT_CANDIDATE_PATTERN})`;
const INSURANCE_ONLY_PATTERN = `(${INSURANCE_PATTERN})`;
const STRONG_PATTERN = `(${STRONG_SETTLEMENT_PATTERN})`;

export interface PendingPage {
  /** Only documents with an id below this one (the previous page's `next_before`). */
  before?: number | null;
  /**
   * Stop starting new documents after this many milliseconds and hand back
   * `next_before` at the last one examined. A document the model reads for
   * the first time takes seconds; without a budget a page of them outlasts
   * the reverse proxy in front of the app (502), and the run is lost.
   */
  budgetMs?: number;
}

/**
 * Every ready document that looks like a settlement and is not yet linked
 * to a depot transaction, run through `enrichDocument` for the given
 * depots. Bounded by `limit` so a backfill over years of statements stays
 * a sequence of short requests: newest first, and `next_before` in the
 * result is where the next call continues (null once the end is reached).
 * A document that stays unlinked — no depot for it, or not a settlement —
 * is examined again on the next full run, never skipped.
 */
export async function enrichPendingDocuments(
  accountIds: number[] | null,
  limit = 200,
  options: EnrichOptions = {},
  page: PendingPage = {},
): Promise<EnrichStats> {
  const stats = emptyStats();
  if (accountIds && accountIds.length === 0) return stats;

  const linked = db
    .select({ id: financeDepotTransactionDocument.document_id })
    .from(financeDepotTransactionDocument);
  const ignored = db
    .select({ id: financeDepotDocumentIgnore.document_id })
    .from(financeDepotDocumentIgnore);

  const pageSize = Math.max(1, Math.min(limit, 1000));
  const conditions = [
    eq(documents.status, "ready"),
    isNotNull(documents.extracted_text),
    sql`${documents.extracted_text} ~* ${CANDIDATE_PATTERN}`,
    sql`NOT (${documents.extracted_text} ~* ${INSURANCE_ONLY_PATTERN} AND ${documents.extracted_text} !~* ${STRONG_PATTERN})`,
    notInArray(documents.id, linked),
  ];
  if (!(options.includeIgnored && options.dryRun)) conditions.push(notInArray(documents.id, ignored));
  if (page.before != null) conditions.push(sql`${documents.id} < ${page.before}`);

  // One more than the page: tells whether there is a next page without a count.
  const found = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(...conditions))
    .orderBy(desc(documents.id))
    .limit(pageSize + 1);
  const candidates = found.slice(0, pageSize);
  stats.next_before = found.length > pageSize ? candidates[candidates.length - 1]!.id : null;

  const started = Date.now();
  for (const [i, c] of candidates.entries()) {
    if (i > 0 && page.budgetMs !== undefined && Date.now() - started >= page.budgetMs) {
      // Out of time: the next call starts below the last one examined.
      stats.next_before = candidates[i - 1]!.id;
      break;
    }
    stats.documents_examined++;
    try {
      const r = await enrichDocument(c.id, accountIds, options);
      stats.results.push(r);
      switch (r.outcome) {
        case "created": stats.created++; break;
        case "enriched": stats.enriched++; break;
        case "linked": stats.linked++; break;
        case "already_linked": stats.already_linked++; break;
        case "not_settlement": stats.skipped_not_settlement++; break;
        case "no_holding": stats.skipped_no_holding++; break;
        case "no_transaction": stats.skipped_no_transaction++; break;
        case "conflict": stats.conflicts++; break;
        case "unverified": stats.unverified++; break;
      }
    } catch (err) {
      stats.errors.push(`document ${c.id}: ${(err as Error).message ?? String(err)}`);
    }
  }
  return stats;
}

/**
 * Document ids linked to each of the given depot transactions, for the
 * transaction lists. Empty arrays for rows without a document.
 */
export async function documentIdsByDepotTransaction(
  depotTransactionIds: number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (depotTransactionIds.length === 0) return out;
  const rows = await db
    .select({
      depot_transaction_id: financeDepotTransactionDocument.depot_transaction_id,
      document_id: financeDepotTransactionDocument.document_id,
    })
    .from(financeDepotTransactionDocument)
    .where(inArray(financeDepotTransactionDocument.depot_transaction_id, depotTransactionIds));
  for (const r of rows) {
    const list = out.get(r.depot_transaction_id) ?? [];
    list.push(r.document_id);
    out.set(r.depot_transaction_id, list);
  }
  return out;
}

/** True when the user marked the document "ignore for depots". */
export async function isIgnoredForDepots(documentId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: financeDepotDocumentIgnore.document_id })
    .from(financeDepotDocumentIgnore)
    .where(eq(financeDepotDocumentIgnore.document_id, documentId))
    .limit(1);
  return row !== undefined;
}

/** Mark or unmark a document as irrelevant to the depots. Idempotent. */
export async function setIgnoredForDepots(documentId: number, ignored: boolean, userId: number): Promise<void> {
  if (ignored) {
    await db
      .insert(financeDepotDocumentIgnore)
      .values({ document_id: documentId, ignored_by: userId })
      .onConflictDoNothing();
  } else {
    await db.delete(financeDepotDocumentIgnore).where(eq(financeDepotDocumentIgnore.document_id, documentId));
  }
}
