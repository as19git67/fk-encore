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
  financeAccountAccess,
  financeAccountHolding,
  financeAccountType,
  financeDepotTransaction,
  financeDepotTransactionDocument,
} from "../db/schema";
import {
  isUsableSettlement,
  parseSettlement,
  type SettlementExtraction,
} from "./depot-settlement-parser";

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
  | "conflict";

export interface EnrichResult {
  document_id: number;
  outcome: EnrichOutcome;
  depot_transaction_id: number | null;
  account_id: number | null;
  /** For `conflict`: what the statement says vs. what the row carries. */
  detail: string | null;
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
  errors: string[];
  results: EnrichResult[];
}

function emptyStats(): EnrichStats {
  return {
    documents_examined: 0,
    created: 0,
    enriched: 0,
    linked: 0,
    already_linked: 0,
    skipped_not_settlement: 0,
    skipped_no_holding: 0,
    conflicts: 0,
    errors: [],
    results: [],
  };
}

interface HoldingMatch {
  account_id: number;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  currency: string | null;
}

/**
 * The depot that holds the security, among `accountIds` (or every depot
 * when null). ISIN first, then WKN; the newest snapshot breaks ties.
 */
async function findHoldingDepot(
  s: SettlementExtraction,
  accountIds: number[] | null,
): Promise<HoldingMatch | null> {
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
  if (blank.length > 0) return { row: pick(blank)!, netAgrees: s.net === null };
  // Rows exist in the window but with a different net: a conflict to report.
  return { row: pick(rows)!, netAgrees: false };
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
): Promise<EnrichResult> {
  const result: EnrichResult = {
    document_id: documentId,
    outcome: "not_settlement",
    depot_transaction_id: null,
    account_id: null,
    detail: null,
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

  const parsed = parseSettlement(doc.extracted_text);
  if (parsed && !parsed.executedAt && doc.doc_date) parsed.executedAt = doc.doc_date.slice(0, 10);
  if (!isUsableSettlement(parsed)) return result;

  // Without an explicit scope, a document only reaches the depots its
  // owner has been given access to; an owner without any ACL row (an
  // admin who sees everything) reaches every depot.
  const scope = accountIds ?? (await accessibleAccountIds(doc.user_id));
  const holding = await findHoldingDepot(parsed, scope);
  if (!holding) {
    result.outcome = "no_holding";
    return result;
  }
  result.account_id = holding.account_id;

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

  const match = await findMatchingDepotTransaction(holding.account_id, parsed);

  if (match && !match.netAgrees) {
    result.outcome = "conflict";
    result.depot_transaction_id = match.row.id;
    result.detail =
      `statement net ${parsed.net?.toFixed(2) ?? "?"} vs. transaction net ${match.row.net_amount ?? "?"} ` +
      `(${match.row.kind} ${match.row.executed_at.slice(0, 10)})`;
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
    if (changed) patch.source = withDocumentSource(row.source);
    if (changed) {
      await db.update(financeDepotTransaction).set(patch).where(eq(financeDepotTransaction.id, row.id));
    }
    await linkDocument(row.id, documentId);
    result.outcome = changed ? "enriched" : "linked";
    result.depot_transaction_id = row.id;
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

/** Cheap SQL pre-filter: words only a settlement or a dividend statement prints. */
const SETTLEMENT_TEXT_PATTERN =
  "(wertpapier-?abrechnung|dividendengutschrift|dividendenabrechnung|ertragsgutschrift|erträgnisgutschrift|ertragsabrechnung|ausschüttung)";

/**
 * Every ready document that looks like a settlement and is not yet linked
 * to a depot transaction, run through `enrichDocument` for the given
 * depots. Bounded by `limit` so a backfill over years of statements stays
 * a sequence of short requests.
 */
export async function enrichPendingDocuments(
  accountIds: number[] | null,
  limit = 200,
): Promise<EnrichStats> {
  const stats = emptyStats();
  if (accountIds && accountIds.length === 0) return stats;

  const linked = db
    .select({ id: financeDepotTransactionDocument.document_id })
    .from(financeDepotTransactionDocument);

  const candidates = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.status, "ready"),
        isNotNull(documents.extracted_text),
        sql`${documents.extracted_text} ~* ${SETTLEMENT_TEXT_PATTERN}`,
        notInArray(documents.id, linked),
      ),
    )
    .orderBy(desc(documents.id))
    .limit(Math.max(1, Math.min(limit, 1000)));

  for (const c of candidates) {
    stats.documents_examined++;
    try {
      const r = await enrichDocument(c.id, accountIds);
      stats.results.push(r);
      switch (r.outcome) {
        case "created": stats.created++; break;
        case "enriched": stats.enriched++; break;
        case "linked": stats.linked++; break;
        case "already_linked": stats.already_linked++; break;
        case "not_settlement": stats.skipped_not_settlement++; break;
        case "no_holding": stats.skipped_no_holding++; break;
        case "conflict": stats.conflicts++; break;
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
