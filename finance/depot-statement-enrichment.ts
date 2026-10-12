/**
 * Depot statements and reportings as holdings (.claude/plans/wertpapier-stamm.md,
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
import { admitSecurity, findSecurity, type SecurityStatus } from "./depot-securities";
import { STRONG_SETTLEMENT_PATTERN } from "./depot-settlement-parser";
import type { LlmMode, LlmStatus } from "./depot-settlement-reader";
import {
  inspectDepotStatement,
  mergeStatement,
  parseLlmStatement,
  STATEMENT_CANDIDATE_PATTERN,
  type LlmStatement,
  type MergedPosition,
  type StatementInspection,
} from "./depot-statement-parser";
import { extractStatementPositions, LlmServiceUnavailableError } from "./llm-client";

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
        const raw = await extractStatementPositions(text);
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
  if (!rules || !rules.statement) return result;

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
  const positions = merged.positions.filter((p) => p.isin || p.wkn);
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
    const depots = await depotsConfirming(positions, scope);
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
    sql`${documents.extracted_text} ~* ${STATEMENT_PATTERN}`,
    sql`${documents.extracted_text} !~* ${STRONG_PATTERN}`,
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

/** The statements whose rows a depot carries, for the holdings views. */
export async function statementDocumentIds(accountId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ id: financeAccountHolding.document_id })
    .from(financeAccountHolding)
    .where(and(eq(financeAccountHolding.account_id, accountId), isNotNull(financeAccountHolding.document_id)));
  return rows.map((r) => r.id!);
}
