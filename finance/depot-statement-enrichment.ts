/**
 * Depot statements and reportings as holdings (documentation/plans/wertpapier-stamm.md,
 * stage 2).
 *
 * A depot statement says what the depot held on a day. Read into
 * `finance_account_holding` with `source = 'document'`, it gives the
 * reconciliation an anchor, the position page a point in its history and,
 * as the oldest paper, the opening position — no cut-off date is needed.
 *
 *   1. the rules recognise the paper (heading words, no settlement
 *      wording), read its date, its depot number and a position per
 *      identifier; the model is asked once for the positions and its
 *      answer kept (finance_document_statement_llm); the model's reading
 *      comes first, the rules fill in (depot-statement-parser),
 *   2. the depot is the one whose number the paper prints, else the one
 *      depot in scope whose securities master confirms a security the
 *      paper lists; otherwise the paper is "unplaced" for the review page,
 *   3. only confirmed securities are stored; a security the master does
 *      not know becomes a proposal with the paper as evidence, so a
 *      position bought before the first paper still gets found. A position
 *      without a quantity is never stored.
 *
 * A second read is a no-op: the rows are keyed by depot, day and security,
 * and a day the bank's sync covers keeps the bank's figures.
 */

import { and, desc, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";

import db from "../db/database";
import {
  documents,
  financeAccountHolding,
  financeDepotDocumentIgnore,
  financeDepotSecurity,
  financeDocumentStatementLlm,
} from "../db/schema";
import {
  accessibleAccountIds,
  findDepotByNumber,
  isIgnoredForDepots,
} from "./depot-document-enrichment";
import { storedPaperType } from "./depot-paper-type";
import { admitSecurity, findConfirmedByName, findSecurity, type SecurityStatus } from "./depot-securities";
import { STRONG_SETTLEMENT_PATTERN } from "./depot-settlement-parser";
import type { LlmMode, LlmStatus } from "./depot-settlement-reader";
import {
  HOLDINGS_TABLE_PATTERN,
  holdingsSection,
  inspectDepotStatement,
  mergeStatement,
  parseLlmStatement,
  repairWkn,
  STATEMENT_CANDIDATE_PATTERN,
  type LlmStatement,
  type MergedPosition,
  type StatementInspection,
} from "./depot-statement-parser";
import { extractStatementPositions, LlmServiceUnavailableError } from "./llm-client";
import { documentsOfPaperType, paperTypeOf } from "./depot-paper-type";
import { enrichDocument } from "./depot-document-enrichment";
import { securityIdentity, type SecurityIdentity } from "./security-identity";

console.log("[boot] finance/depot-statement-enrichment.ts: all imports resolved");

export type StatementOutcome =
  /** Holdings rows were written for the paper's day. */
  | "stored"
  /** Every position the paper lists is stored already (or stays so, see `detail`). */
  | "already_stored"
  | "not_statement"
  /** No depot number matched and no depot's master confirms any of the paper's securities. */
  | "no_depot"
  /** A statement, but no position with an identifier and a quantity. */
  | "no_positions"
  /** The user marked the document "ignore for depots". */
  | "ignored";

export type StatementMatchedBy = "depot_number" | "securities";

export interface StatementResult {
  document_id: number;
  outcome: StatementOutcome;
  account_id: number | null;
  /** The day the holdings are stated for. */
  as_of: string | null;
  depot_number: string | null;
  matched_by: StatementMatchedBy | null;
  /** Positions with an identifier the paper lists. */
  positions_found: number;
  /** Written (or, in a dry run, would be written) as holdings. */
  positions_stored: number;
  /** Securities the master has not confirmed: proposed, not stored. */
  positions_proposed: number;
  /** Securities the user ignored for this depot. */
  positions_ignored: number;
  /** Confirmed securities whose quantity could not be read. */
  positions_unreadable: number;
  /** The identifiers the paper lists (ISIN, else WKN), at most five — the review page's reason line. */
  identifiers: string[];
  llm_status: LlmStatus | null;
  detail: string | null;
  ignored: boolean;
}

export interface StatementOptions {
  /** Report what would happen without writing anything (no proposals either). */
  dryRun?: boolean;
  /** Whether the language model may be asked. Defaults to "cache-only" for a dry run and "allow" otherwise. */
  llm?: LlmMode;
  /** Read documents the user marked "ignore for depots" as well (dry runs only). */
  includeIgnored?: boolean;
}

export interface StatementStats {
  documents_examined: number;
  stored: number;
  already_stored: number;
  not_statement: number;
  no_depot: number;
  no_positions: number;
  positions_stored: number;
  positions_proposed: number;
  errors: string[];
  results: StatementResult[];
  /** Where the next page starts (`before` of the next call); null when this was the last. */
  next_before: number | null;
}

function emptyStats(): StatementStats {
  return {
    documents_examined: 0,
    stored: 0,
    already_stored: 0,
    not_statement: 0,
    no_depot: 0,
    no_positions: 0,
    positions_stored: 0,
    positions_proposed: 0,
    errors: [],
    results: [],
    next_before: null,
  };
}

async function storedAnswer(documentId: number): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ values: financeDocumentStatementLlm.values })
    .from(financeDocumentStatementLlm)
    .where(eq(financeDocumentStatementLlm.document_id, documentId))
    .limit(1);
  return row?.values ?? null;
}

interface StatementReading {
  rules: StatementInspection;
  llm: LlmStatement | null;
  llmStatus: LlmStatus;
}

/** The rules' and the model's reading of one statement; the model asked once, its answer kept. */
async function readStatement(documentId: number, rules: StatementInspection, text: string, mode: LlmMode): Promise<StatementReading> {
  let llm: LlmStatement | null = null;
  let llmStatus: LlmStatus = mode === "off" ? "off" : "skipped";
  if (mode !== "off") {
    const stored = await storedAnswer(documentId);
    if (stored) {
      llm = parseLlmStatement(stored);
      llmStatus = "cached";
    } else if (mode === "allow") {
      try {
        // A long report: the model reads its head and the holdings table, not the account pages before it.
        const raw = await extractStatementPositions(holdingsSection(text) ?? text);
        await db
          .insert(financeDocumentStatementLlm)
          .values({ document_id: documentId, values: raw })
          .onConflictDoUpdate({
            target: financeDocumentStatementLlm.document_id,
            set: { values: raw, created_at: new Date().toISOString() },
          });
        llm = parseLlmStatement(raw);
        llmStatus = "used";
      } catch (err) {
        if (!(err instanceof LlmServiceUnavailableError)) {
          console.warn(`[finance] statement LLM read failed for document=${documentId}:`, (err as Error).message);
        }
        llmStatus = "unavailable";
      }
    }
  }
  // Positions only count with an identifier the text shows: the model reads, the text checks.
  if (llm) {
    const compact = text.toUpperCase().replace(/\s+/g, "");
    // An identifier as OCR printed it may carry an O for a 0: compared with
    // O/0 and I/1 alike (repairWkn maps both the same way).
    const compactWkn = repairWkn(compact);
    llm = {
      ...llm,
      positions: llm.positions
        .map((p) => ({
          ...p,
          isin: p.isin && compactWkn.includes(repairWkn(p.isin)) ? p.isin : null,
          wkn: p.wkn && compactWkn.includes(p.wkn) ? p.wkn : null,
        }))
        .filter((p) => p.isin || p.wkn),
    };
  }
  return { rules, llm, llmStatus };
}

/**
 * The depots in scope whose master confirms one of the identifiers. The
 * depot a statement belongs to, when exactly one qualifies.
 */
async function depotsConfirming(positions: MergedPosition[], accountIds: number[] | null): Promise<number[]> {
  const isins = positions.map((p) => p.isin).filter((x): x is string => x !== null);
  const wkns = positions.map((p) => p.wkn).filter((x): x is string => x !== null);
  const idMatches = [];
  if (isins.length > 0) idMatches.push(inArray(financeDepotSecurity.isin, isins));
  if (wkns.length > 0) idMatches.push(inArray(financeDepotSecurity.wkn, wkns));
  if (idMatches.length === 0) return [];
  const conditions = [eq(financeDepotSecurity.status, "confirmed"), or(...idMatches)!];
  if (accountIds) {
    if (accountIds.length === 0) return [];
    conditions.push(inArray(financeDepotSecurity.account_id, accountIds));
  }
  const rows = await db
    .selectDistinct({ account_id: financeDepotSecurity.account_id })
    .from(financeDepotSecurity)
    .where(and(...conditions));
  return rows.map((r) => r.account_id);
}

/** The depots in scope where a WKN-only position's name stands for exactly one confirmed security. */
async function depotsConfirmingByName(positions: MergedPosition[], accountIds: number[] | null): Promise<number[]> {
  const named = positions.filter((p) => !p.isin && p.name);
  if (named.length === 0) return [];
  const conditions = [eq(financeDepotSecurity.status, "confirmed")];
  if (accountIds) {
    if (accountIds.length === 0) return [];
    conditions.push(inArray(financeDepotSecurity.account_id, accountIds));
  }
  const candidates = await db
    .selectDistinct({ account_id: financeDepotSecurity.account_id })
    .from(financeDepotSecurity)
    .where(and(...conditions));
  const out: number[] = [];
  for (const c of candidates) {
    for (const p of named) {
      if (await findConfirmedByName(c.account_id, p.name)) {
        out.push(c.account_id);
        break;
      }
    }
  }
  return out;
}

/**
 * Whether a position belongs to the paper's holdings table. The model
 * reads the whole paper and may list a security the report only mentions
 * as a trade or a booking — with a quantity from somewhere near it. The
 * table names its rows by WKN, so a position counts when its WKN (or the
 * one its ISIN is known by) is a row's.
 */
export function tableMembership(
  tableWkns: string[],
  identity: SecurityIdentity,
): (p: { isin: string | null; wkn: string | null }) => boolean {
  const wkns = new Set(tableWkns.map((w) => repairWkn(w)));
  return (p) => {
    const wkn = identity.complete({ isin: p.isin, wkn: p.wkn }).wkn;
    return wkn !== null && wkns.has(repairWkn(wkn));
  };
}

function fixed(n: number | null, scale: number): string | null {
  return n === null ? null : n.toFixed(scale);
}

/**
 * Read one document as a depot statement into the holdings of its depot.
 * `accountIds` limits the depots considered (null: every depot the owner
 * reaches).
 */
export async function readDepotStatement(
  documentId: number,
  accountIds: number[] | null = null,
  options: StatementOptions = {},
): Promise<StatementResult> {
  const dryRun = options.dryRun === true;
  const result: StatementResult = {
    document_id: documentId,
    outcome: "not_statement",
    account_id: null,
    as_of: null,
    depot_number: null,
    matched_by: null,
    positions_found: 0,
    positions_stored: 0,
    positions_proposed: 0,
    positions_ignored: 0,
    positions_unreadable: 0,
    identifiers: [],
    llm_status: null,
    detail: null,
    ignored: false,
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
  if (!doc || doc.status !== "ready" || !doc.extracted_text) return result;

  result.ignored = await isIgnoredForDepots(documentId);
  if (result.ignored && !(options.includeIgnored && dryRun)) {
    result.outcome = "ignored";
    return result;
  }

  const rules = inspectDepotStatement(doc.extracted_text);
  if (!rules) return result;
  // No heading the rules know: a statement only when the model said so (stage 3).
  if (!rules.statement && (await storedPaperType(documentId)) !== "statement") return result;

  const reading = await readStatement(documentId, rules, doc.extracted_text, options.llm ?? (dryRun ? "cache-only" : "allow"));
  result.llm_status = reading.llmStatus;
  // The model took the paper for something else — a settlement, a policy letter.
  if (reading.llm?.isStatement === false) {
    result.detail = "llm_other";
    return result;
  }

  const merged = mergeStatement(rules, reading.llm);
  result.as_of = merged.asOf ?? doc.doc_date?.slice(0, 10) ?? null;
  result.depot_number = merged.depotNumber;
  const inTable = rules.tableWkns.length > 0 ? tableMembership(rules.tableWkns, await securityIdentity()) : null;
  const positions = merged.positions.filter((p) => (p.isin || p.wkn) && (inTable === null || inTable(p)));
  result.positions_found = positions.length;
  result.identifiers = positions.map((p) => (p.isin ?? p.wkn)!).slice(0, 5);
  if (positions.length === 0 || result.as_of === null) {
    result.outcome = "no_positions";
    result.detail = result.as_of === null ? "no date" : null;
    return result;
  }

  const scope = accountIds ?? (await accessibleAccountIds(doc.user_id));
  let accountId: number | null = null;
  if (merged.depotNumber) {
    accountId = await findDepotByNumber(merged.depotNumber, scope);
    if (accountId !== null) result.matched_by = "depot_number";
  }
  if (accountId === null) {
    let depots = await depotsConfirming(positions, scope);
    // WKN-only rows against a master that holds ISINs: the names place the paper.
    if (depots.length === 0) depots = await depotsConfirmingByName(positions, scope);
    if (depots.length === 1) {
      accountId = depots[0]!;
      result.matched_by = "securities";
    } else if (depots.length > 1) {
      result.detail = "securities confirmed in more than one depot";
    }
  }
  if (accountId === null) {
    result.outcome = "no_depot";
    return result;
  }
  result.account_id = accountId;

  let inserted = 0;
  let existing = 0;
  for (const p of positions) {
    const ids = { isin: p.isin, wkn: p.wkn, name: p.name };
    // A row with the WKN alone, for a security the master knows only by its ISIN: the name tells.
    if (!ids.isin && ids.wkn && !(await findSecurity(accountId, ids))) {
      const byName = await findConfirmedByName(accountId, p.name);
      if (byName) ids.isin = byName.isin;
    }
    // A dry run only looks: no proposal is written for what it sees.
    const status: SecurityStatus = dryRun
      ? ((await findSecurity(accountId, ids))?.status as SecurityStatus | undefined) ?? "proposed"
      : await admitSecurity(accountId, ids, "document", { documentId });
    const master = dryRun ? null : await findSecurity(accountId, ids);
    if (status === "ignored") {
      result.positions_ignored++;
      continue;
    }
    if (status !== "confirmed") {
      result.positions_proposed++;
      continue;
    }
    if (p.quantity === null) {
      result.positions_unreadable++;
      continue;
    }
    result.positions_stored++;
    if (dryRun) continue;
    // The master's identifiers complete the paper's, so the row keys like the bank's.
    const isin = p.isin ?? master?.isin ?? null;
    const wkn = p.wkn ?? master?.wkn ?? null;
    const name = p.name ?? master?.name ?? null;
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO finance_account_holding
        (account_id, as_of, isin, wkn, name, amount, price, value, currency, acquisition_price, source, document_id)
      VALUES (
        ${accountId}, ${result.as_of}::date,
        ${isin}, ${wkn}, ${name},
        ${fixed(p.quantity, 8)}, ${fixed(p.price, 6)}, ${fixed(p.value, 2)}, ${p.currency},
        ${fixed(p.acquisitionPrice, 6)}, 'document', ${documentId}
      )
      ON CONFLICT (account_id, as_of, COALESCE(isin, wkn, name)) DO NOTHING
      RETURNING id
    `);
    if (rows.rows.length > 0) inserted++;
    else existing++;
  }

  if (dryRun) {
    result.outcome = result.positions_stored > 0 ? "stored" : "no_positions";
    if (result.positions_stored === 0 && result.positions_proposed > 0) result.detail = "securities proposed, awaiting the user";
    return result;
  }
  if (inserted > 0) result.outcome = "stored";
  else if (existing > 0) result.outcome = "already_stored";
  else {
    result.outcome = "no_positions";
    if (result.positions_proposed > 0) result.detail = "securities proposed, awaiting the user";
  }
  return result;
}

/** One position as a statement lists it, for the document dialog. */
export interface StatementPositionView {
  isin: string | null;
  wkn: string | null;
  name: string | null;
  quantity: string | null;
  price: string | null;
  value: string | null;
  currency: string | null;
  /** quantity × price ≈ value; null when a figure is missing. */
  checked: boolean | null;
  source: MergedPosition["source"];
  /** A holdings row for this security was stored from this paper. */
  stored: boolean;
  /**
   * What the depot's master says about the security: "ignored" for one the
   * user took out of the depot, null when the depot is unknown or the master
   * has no entry. Tells the dialog why a position is not stored.
   */
  security_status: SecurityStatus | null;
}

/** What a depot statement says and what was taken from it into the holdings. */
export interface StatementView {
  as_of: string | null;
  depot_number: string | null;
  /** What reading it now would do (dry run, the model's stored answer only). */
  result: StatementResult;
  positions: StatementPositionView[];
  /** Holdings rows stored from this paper that the reading no longer lists. */
  stored_only: Array<{ isin: string | null; wkn: string | null; name: string | null; quantity: string | null }>;
}

/**
 * The positions a statement lists, as the dialog shows them: the rules'
 * and the model's merged reading, each marked with whether a holdings row
 * was stored from this paper for it. A position the paper lists but the
 * holdings miss is the one the reconciliation then sees as sold. Null when
 * the paper is no statement.
 */
export async function inspectStatement(documentId: number, text: string | null, accountIds: number[]): Promise<StatementView | null> {
  const rules = inspectDepotStatement(text);
  if (!rules || !text) return null;
  if (!rules.statement && (await storedPaperType(documentId)) !== "statement") return null;
  const reading = await readStatement(documentId, rules, text, "cache-only");
  const merged = mergeStatement(rules, reading.llm);
  const identity = await securityIdentity();
  const inTable = rules.tableWkns.length > 0 ? tableMembership(rules.tableWkns, identity) : null;
  const positions = merged.positions.filter((p) => (p.isin || p.wkn) && (inTable === null || inTable(p)));
  const stored = (
    await db
      .select({
        isin: financeAccountHolding.isin,
        wkn: financeAccountHolding.wkn,
        name: financeAccountHolding.name,
        amount: financeAccountHolding.amount,
      })
      .from(financeAccountHolding)
      .where(eq(financeAccountHolding.document_id, documentId))
  ).map((r) => identity.complete(r));
  const same = (a: { isin: string | null; wkn: string | null }, b: { isin: string | null; wkn: string | null }) =>
    (a.isin !== null && a.isin === b.isin) || (a.wkn !== null && b.wkn !== null && repairWkn(a.wkn) === repairWkn(b.wkn));
  const result = await readDepotStatement(documentId, accountIds, { dryRun: true, llm: "cache-only", includeIgnored: true });
  const accountId = result.account_id;
  const views = await Promise.all(positions.map(async (p): Promise<StatementPositionView> => {
    const c = identity.complete(p);
    const master = accountId === null ? null : await findSecurity(accountId, c);
    return {
      isin: c.isin,
      wkn: c.wkn,
      name: p.name,
      quantity: fixed(p.quantity, 8),
      price: fixed(p.price, 6),
      value: fixed(p.value, 2),
      currency: p.currency,
      checked: p.checked,
      source: p.source,
      stored: stored.some((s) => same(s, c)),
      security_status: (master?.status as SecurityStatus | undefined) ?? null,
    };
  }));
  return {
    as_of: merged.asOf,
    depot_number: merged.depotNumber,
    result,
    positions: views,
    stored_only: stored
      .filter((s) => !views.some((v) => same(s, v)))
      .map((s) => ({ isin: s.isin, wkn: s.wkn, name: s.name, quantity: s.amount })),
  };
}

/**
 * A document that was just classified, read for the depots: the model is
 * asked which kind of paper it is when the rules do not recognise its
 * wording, then the settlement reader and the statement reader each take
 * what is theirs. Each step is a no-op for a paper that is not its kind.
 */
export async function readDepotPaper(documentId: number): Promise<void> {
  const [doc] = await db
    .select({ status: documents.status, extracted_text: documents.extracted_text })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc || doc.status !== "ready") return;
  await paperTypeOf(documentId, doc.extracted_text);
  await enrichDocument(documentId);
  await readDepotStatement(documentId);
}

const STATEMENT_PATTERN = `(${STATEMENT_CANDIDATE_PATTERN})`;
const STRONG_PATTERN = `(${STRONG_SETTLEMENT_PATTERN})`;

export interface StatementPage {
  before?: number | null;
  /** Stop starting new documents after this many milliseconds (see enrichPendingDocuments). */
  budgetMs?: number;
}

/**
 * Every ready document that reads like a depot statement and has no
 * holdings rows yet, run through `readDepotStatement` for the given depots.
 * Paged like the settlement run: newest first, `next_before` continues.
 */
export async function enrichPendingStatements(
  accountIds: number[] | null,
  limit = 200,
  options: StatementOptions = {},
  page: StatementPage = {},
): Promise<StatementStats> {
  const stats = emptyStats();
  if (accountIds && accountIds.length === 0) return stats;

  const stored = db
    .select({ id: financeAccountHolding.document_id })
    .from(financeAccountHolding)
    .where(isNotNull(financeAccountHolding.document_id));
  const ignored = db.select({ id: financeDepotDocumentIgnore.document_id }).from(financeDepotDocumentIgnore);

  const pageSize = Math.max(1, Math.min(limit, 1000));
  const conditions = [
    eq(documents.status, "ready"),
    isNotNull(documents.extracted_text),
    or(
      and(sql`${documents.extracted_text} ~* ${STATEMENT_PATTERN}`, sql`${documents.extracted_text} !~* ${STRONG_PATTERN}`),
      // A report with a holdings table among its trades and account pages.
      sql`${documents.extracted_text} ~* ${HOLDINGS_TABLE_PATTERN}`,
      // Worded unlike anything the rules know, but the model took it for a statement.
      inArray(documents.id, documentsOfPaperType(["statement"])),
    )!,
    notInArray(documents.id, stored),
  ];
  if (!(options.includeIgnored && options.dryRun)) conditions.push(notInArray(documents.id, ignored));
  if (page.before != null) conditions.push(sql`${documents.id} < ${page.before}`);

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
      stats.next_before = candidates[i - 1]!.id;
      break;
    }
    stats.documents_examined++;
    try {
      const r = await readDepotStatement(c.id, accountIds, options);
      stats.results.push(r);
      stats.positions_stored += r.positions_stored;
      stats.positions_proposed += r.positions_proposed;
      switch (r.outcome) {
        case "stored": stats.stored++; break;
        case "already_stored": stats.already_stored++; break;
        case "not_statement": stats.not_statement++; break;
        case "no_depot": stats.no_depot++; break;
        case "no_positions": stats.no_positions++; break;
        case "ignored": break;
      }
    } catch (err) {
      stats.errors.push(`document ${c.id}: ${(err as Error).message ?? String(err)}`);
    }
  }
  return stats;
}

/**
 * Holdings rows a report's trade list or account pages put in before the
 * statement reader kept to the holdings table (see tableMembership): for
 * every paper with a holdings table, the rows it gave a security the table
 * does not list are deleted. Returns how many went.
 */
export async function pruneStatementHoldings(accountIds: number[] | null): Promise<number> {
  if (accountIds && accountIds.length === 0) return 0;
  const conditions = [eq(financeAccountHolding.source, "document"), isNotNull(financeAccountHolding.document_id)];
  if (accountIds) conditions.push(inArray(financeAccountHolding.account_id, accountIds));
  const rows = await db
    .select({
      id: financeAccountHolding.id,
      document_id: financeAccountHolding.document_id,
      isin: financeAccountHolding.isin,
      wkn: financeAccountHolding.wkn,
    })
    .from(financeAccountHolding)
    .where(and(...conditions));
  if (rows.length === 0) return 0;

  const docIds = [...new Set(rows.map((r) => r.document_id!))];
  const texts = await db
    .select({ id: documents.id, extracted_text: documents.extracted_text })
    .from(documents)
    .where(inArray(documents.id, docIds));
  const identity = await securityIdentity();
  const membership = new Map<number, ReturnType<typeof tableMembership>>();
  for (const d of texts) {
    const tableWkns = inspectDepotStatement(d.extracted_text)?.tableWkns ?? [];
    if (tableWkns.length > 0) membership.set(d.id, tableMembership(tableWkns, identity));
  }
  const stale = rows.filter((r) => {
    const inTable = membership.get(r.document_id!);
    return inTable !== undefined && !inTable(r);
  });
  if (stale.length === 0) return 0;
  await db.delete(financeAccountHolding).where(inArray(financeAccountHolding.id, stale.map((r) => r.id)));
  return stale.length;
}

/** The statements whose rows a depot carries, for the holdings views. */
export async function statementDocumentIds(accountId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ id: financeAccountHolding.document_id })
    .from(financeAccountHolding)
    .where(and(eq(financeAccountHolding.account_id, accountId), isNotNull(financeAccountHolding.document_id)));
  return rows.map((r) => r.id!);
}
