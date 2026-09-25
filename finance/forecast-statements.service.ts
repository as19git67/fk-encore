// Retirement forecast — statements as the source of contract values (#1343).
//
// The logic, without endpoints, so documents' runClassify can call
// onDocumentClassified the way it calls document-match.service.ts. The
// endpoints live in forecast-statements.ts.
//
// Contract items (life insurance, pensions, premiums booked as expenses)
// carry a contract number (data.contractNo). This module
//
//   1. finds the documents that belong to such an item: first through the
//      reference tags the documents pipeline writes (versicherungsnr:…,
//      vertragsnr:…), else through the document text;
//   2. reads the values a statement states (forecast-statements-extract.ts
//      plus the language model when it is reachable);
//   3. offers the differences to the item as correction proposals the user
//      accepts or rejects — nothing is overwritten silently;
//   4. does the same for every new document the moment it is classified.
//
// Only documents the item's owner may see are ever linked. Finance reads the
// documents tables directly, as document-match.service.ts does, but — unlike
// that service — always under the visibility rule of documents/visibility.ts.

import { and, asc, desc, eq, ilike, inArray, like, or, sql, type SQL } from "drizzle-orm";

import db from "../db/database";
import {
  documentTagLinks,
  documentTags,
  documents,
  financeForecastDocumentLink,
  financeForecastItem,
  financeForecastStatement,
  groupMembers,
  type ForecastStatementValues,
} from "../db/schema";
import type { ItemType } from "./forecast-engine";
import {
  LLM_FIELDS,
  computeProposals,
  contractKey,
  hasAnyValue,
  isSearchableKey,
  mergeStatementValues,
  parseLlmStatement,
  parseStatementText,
  type Proposal,
  type ValuesSource,
} from "./forecast-statements-extract";
import { extractStatementValues, LlmServiceUnavailableError } from "./llm-client";

console.log("[boot] finance/forecast-statements.service.ts: all imports resolved");

// -----------------------------------------------------------------------
// DTOs
// -----------------------------------------------------------------------

export interface StatementLinkDto {
  id: number;
  documentId: number;
  title: string | null;
  docDate: string | null;
  documentType: string | null;
  matchKind: "tag" | "text" | "user";
  status: "suggested" | "confirmed" | "rejected";
}

export interface StatementDto {
  id: number;
  documentId: number;
  referenceDate: string | null;
  values: ForecastStatementValues;
  method: "regex" | "llm";
  status: "proposed" | "accepted" | "rejected" | "no_change";
  extractedAt: string;
}

export interface ItemStatementState {
  itemId: number;
  contractNo: string | null;
  links: StatementLinkDto[];
  /** The newest statement that was read; proposals refer to it. */
  latest: StatementDto | null;
  proposals: Proposal[];
  /** Accepted statements, newest first. */
  history: StatementDto[];
  /** Where the item's values come from right now. */
  valuesSource: ValuesSource | null;
  /** The last statement is more than 14 months old. */
  overdue: boolean;
  /** Documents are being read in the background. */
  reading: boolean;
}

export interface StatementsResponse {
  items: ItemStatementState[];
}

export interface ScanSummary {
  itemsWithContract: number;
  linkedByTag: number;
  suggestedByText: number;
  /** Documents queued for reading. */
  queued: number;
}

// -----------------------------------------------------------------------
// Visibility — the rule of documents/visibility.ts
// -----------------------------------------------------------------------

async function groupIdsOf(userId: number): Promise<number[]> {
  const rows = await db.select({ id: groupMembers.group_id }).from(groupMembers).where(eq(groupMembers.user_id, userId));
  return rows.map((r) => r.id);
}

function visibleTo(userId: number, groupIds: number[]): SQL {
  const own = and(eq(documents.visibility, "private"), eq(documents.user_id, userId))!;
  if (groupIds.length === 0) return own;
  return or(own, and(eq(documents.visibility, "group"), inArray(documents.group_id, groupIds))!)!;
}

// -----------------------------------------------------------------------
// Finding documents
// -----------------------------------------------------------------------

const TAG_PREFIXES = ["versicherungsnr:", "vertragsnr:"];

/** Two contract keys name the same contract: equal, or one contains the other and is long enough to mean it. */
export function keysMatch(itemKey: string, docKey: string): boolean {
  if (itemKey === docKey) return true;
  const [short, long] = itemKey.length <= docKey.length ? [itemKey, docKey] : [docKey, itemKey];
  return short.length >= 8 && long.includes(short);
}

interface ContractItem {
  id: number;
  userId: number;
  type: ItemType;
  label: string;
  data: Record<string, unknown>;
  contractNo: string;
  key: string;
}

function contractItemOf(row: typeof financeForecastItem.$inferSelect): ContractItem | null {
  const no = typeof row.data?.contractNo === "string" ? (row.data.contractNo as string).trim() : "";
  if (!no) return null;
  const key = contractKey(no);
  if (!isSearchableKey(key)) return null;
  return { id: row.id, userId: row.user_id, type: row.type, label: row.label, data: row.data, contractNo: no, key };
}

/** Visible documents that carry a contract reference tag, with the tag's key. */
async function taggedDocuments(userId: number, groupIds: number[]): Promise<Array<{ documentId: number; key: string }>> {
  const rows = await db
    .select({ documentId: documentTagLinks.document_id, name: documentTags.name })
    .from(documentTagLinks)
    .innerJoin(documentTags, eq(documentTags.id, documentTagLinks.tag_id))
    .innerJoin(documents, eq(documents.id, documentTagLinks.document_id))
    .where(and(or(...TAG_PREFIXES.map((p) => like(documentTags.name, `${p}%`))), visibleTo(userId, groupIds)));
  return rows.map((r) => ({ documentId: r.documentId, key: contractKey(r.name.slice(r.name.indexOf(":") + 1)) }));
}

/** Visible, readable documents whose text contains the contract number. */
async function documentsByText(userId: number, groupIds: number[], contractNo: string): Promise<number[]> {
  const pattern = `%${contractNo.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.status, "ready"), ilike(documents.extracted_text, pattern), visibleTo(userId, groupIds)))
    .orderBy(desc(documents.doc_date))
    .limit(20);
  return rows.map((r) => r.id);
}

async function upsertLink(
  userId: number,
  itemId: number,
  documentId: number,
  matchKind: "tag" | "text",
): Promise<"new-confirmed" | "new-suggested" | "existing"> {
  const status = matchKind === "tag" ? "confirmed" : "suggested";
  const inserted = await db
    .insert(financeForecastDocumentLink)
    .values({ user_id: userId, item_id: itemId, document_id: documentId, match_kind: matchKind, status, decided_at: status === "confirmed" ? new Date().toISOString() : null })
    .onConflictDoNothing()
    .returning({ id: financeForecastDocumentLink.id });
  if (inserted.length === 0) {
    // A text suggestion becomes confirmed once the tag shows up — never a rejected one.
    if (matchKind === "tag") {
      await db
        .update(financeForecastDocumentLink)
        .set({ status: "confirmed", match_kind: "tag", decided_at: new Date().toISOString() })
        .where(
          and(
            eq(financeForecastDocumentLink.item_id, itemId),
            eq(financeForecastDocumentLink.document_id, documentId),
            eq(financeForecastDocumentLink.status, "suggested"),
          ),
        );
    }
    return "existing";
  }
  return status === "confirmed" ? "new-confirmed" : "new-suggested";
}

// -----------------------------------------------------------------------
// Reading statements
// -----------------------------------------------------------------------

/** Items whose documents are being read right now — shown as "wird gelesen". */
const reading = new Set<number>();

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Reads one document for one item and stores what it says. `force` reads it
 * again even when it was read before (the user asked, or the text changed).
 */
export async function readStatement(itemId: number, documentId: number, force = false): Promise<void> {
  const [item] = await db.select().from(financeForecastItem).where(eq(financeForecastItem.id, itemId));
  if (!item) return;
  if (!force) {
    const [existing] = await db
      .select({ id: financeForecastStatement.id })
      .from(financeForecastStatement)
      .where(and(eq(financeForecastStatement.item_id, itemId), eq(financeForecastStatement.document_id, documentId)));
    if (existing) return;
  }
  const [doc] = await db
    .select({ text: documents.extracted_text, docDate: documents.doc_date })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc?.text) return;

  const regex = parseStatementText(doc.text);
  let llm = null;
  try {
    const raw = await extractStatementValues(doc.text, LLM_FIELDS, {
      itemLabel: item.label,
      contractNo: typeof item.data?.contractNo === "string" ? (item.data.contractNo as string) : null,
    });
    llm = parseLlmStatement(raw);
  } catch (err) {
    if (!(err instanceof LlmServiceUnavailableError)) throw err;
    console.warn(`[forecast] statement ${documentId}: language model unavailable, patterns only (${err.message})`);
  }
  const { values, method } = mergeStatementValues(regex, llm, today());
  if (!values.referenceDate && doc.docDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.docDate)) values.referenceDate = doc.docDate;
  if (!hasAnyValue(values)) return; // a letter without figures — nothing to store

  const proposals = computeProposals(item.type, item.data, values);
  const status = proposals.length > 0 ? "proposed" : "no_change";
  await db
    .insert(financeForecastStatement)
    .values({
      user_id: item.user_id,
      item_id: itemId,
      document_id: documentId,
      reference_date: values.referenceDate,
      values,
      method,
      status,
    })
    .onConflictDoUpdate({
      target: [financeForecastStatement.item_id, financeForecastStatement.document_id],
      set: { reference_date: values.referenceDate, values, method, status, extracted_at: new Date().toISOString(), decided_at: null },
    });
}

export async function readAll(pairs: Array<{ itemId: number; documentId: number }>, force = false): Promise<void> {
  const items = new Set(pairs.map((p) => p.itemId));
  for (const id of items) reading.add(id);
  try {
    for (const p of pairs) {
      try {
        await readStatement(p.itemId, p.documentId, force);
      } catch (err) {
        console.error(`[forecast] reading document ${p.documentId} for item ${p.itemId} failed:`, err);
      }
    }
  } finally {
    for (const id of items) reading.delete(id);
  }
}

// -----------------------------------------------------------------------
// Scanning
// -----------------------------------------------------------------------

/**
 * Links the user's contract items to their documents and reads the
 * confirmed ones. With `wait` the reading is awaited (tests, small scans);
 * otherwise it runs after the response and the page shows "wird gelesen".
 */
export async function scanForUser(userId: number, itemIds: number[] | null, opts: { wait?: boolean } = {}): Promise<ScanSummary> {
  const rows = await db
    .select()
    .from(financeForecastItem)
    .where(
      itemIds && itemIds.length > 0
        ? and(eq(financeForecastItem.user_id, userId), inArray(financeForecastItem.id, itemIds))
        : eq(financeForecastItem.user_id, userId),
    );
  const items = rows.map(contractItemOf).filter((x): x is ContractItem => x !== null);
  const summary: ScanSummary = { itemsWithContract: items.length, linkedByTag: 0, suggestedByText: 0, queued: 0 };
  if (items.length === 0) return summary;

  const groupIds = await groupIdsOf(userId);
  const tagged = await taggedDocuments(userId, groupIds);
  for (const item of items) {
    const byTag = [...new Set(tagged.filter((t) => keysMatch(item.key, t.key)).map((t) => t.documentId))];
    for (const docId of byTag) if ((await upsertLink(userId, item.id, docId, "tag")) === "new-confirmed") summary.linkedByTag++;
    if (byTag.length === 0) {
      for (const docId of await documentsByText(userId, groupIds, item.contractNo)) {
        if ((await upsertLink(userId, item.id, docId, "text")) === "new-suggested") summary.suggestedByText++;
      }
    }
  }

  // Read every confirmed link that has not been read yet.
  const confirmed = await db
    .select({ itemId: financeForecastDocumentLink.item_id, documentId: financeForecastDocumentLink.document_id })
    .from(financeForecastDocumentLink)
    .leftJoin(
      financeForecastStatement,
      and(
        eq(financeForecastStatement.item_id, financeForecastDocumentLink.item_id),
        eq(financeForecastStatement.document_id, financeForecastDocumentLink.document_id),
      ),
    )
    .where(
      and(
        eq(financeForecastDocumentLink.user_id, userId),
        eq(financeForecastDocumentLink.status, "confirmed"),
        inArray(
          financeForecastDocumentLink.item_id,
          items.map((i) => i.id),
        ),
        sql`${financeForecastStatement.id} IS NULL`,
      ),
    );
  summary.queued = confirmed.length;
  if (confirmed.length > 0) {
    const job = readAll(confirmed);
    if (opts.wait) await job;
    else void job;
  }
  return summary;
}

/**
 * A document finished classification: link it to every contract item it
 * names whose owner may see it, and read it. Called from documents'
 * runClassify, next to the other finance hooks; failures are the caller's
 * to log, never to raise.
 */
export async function onDocumentClassified(documentId: number): Promise<void> {
  const tags = await db
    .select({ name: documentTags.name })
    .from(documentTagLinks)
    .innerJoin(documentTags, eq(documentTags.id, documentTagLinks.tag_id))
    .where(and(eq(documentTagLinks.document_id, documentId), or(...TAG_PREFIXES.map((p) => like(documentTags.name, `${p}%`)))));
  const keys = tags.map((t) => contractKey(t.name.slice(t.name.indexOf(":") + 1))).filter(isSearchableKey);
  if (keys.length === 0) return;

  const [doc] = await db
    .select({ userId: documents.user_id, visibility: documents.visibility, groupId: documents.group_id })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc) return;

  const candidates = (await db.select().from(financeForecastItem))
    .map(contractItemOf)
    .filter((x): x is ContractItem => x !== null && keys.some((k) => keysMatch(x.key, k)));
  const pairs: Array<{ itemId: number; documentId: number }> = [];
  for (const item of candidates) {
    const canSee =
      (doc.visibility === "private" && doc.userId === item.userId) ||
      (doc.visibility === "group" && doc.groupId != null && (await groupIdsOf(item.userId)).includes(doc.groupId));
    if (!canSee) continue;
    await upsertLink(item.userId, item.id, documentId, "tag");
    pairs.push({ itemId: item.id, documentId });
  }
  if (pairs.length > 0) await readAll(pairs);
}

// -----------------------------------------------------------------------
// State per item
// -----------------------------------------------------------------------

export function toStatementDto(r: typeof financeForecastStatement.$inferSelect): StatementDto {
  return {
    id: r.id,
    documentId: r.document_id,
    referenceDate: r.reference_date,
    values: r.values,
    method: r.method,
    status: r.status,
    extractedAt: r.extracted_at,
  };
}

function monthsBetween(fromIso: string, toIso: string): number {
  const [fy, fm] = [Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7))];
  const [ty, tm] = [Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7))];
  return (ty - fy) * 12 + (tm - fm);
}

export async function statementsForUser(userId: number): Promise<StatementsResponse> {
  const itemRows = await db
    .select()
    .from(financeForecastItem)
    .where(eq(financeForecastItem.user_id, userId))
    .orderBy(asc(financeForecastItem.id));
  const [links, statements] = await Promise.all([
    db
      .select({
        id: financeForecastDocumentLink.id,
        itemId: financeForecastDocumentLink.item_id,
        documentId: financeForecastDocumentLink.document_id,
        matchKind: financeForecastDocumentLink.match_kind,
        status: financeForecastDocumentLink.status,
        title: documents.title,
        docDate: documents.doc_date,
        documentType: documents.document_type,
      })
      .from(financeForecastDocumentLink)
      .innerJoin(documents, eq(documents.id, financeForecastDocumentLink.document_id))
      .where(eq(financeForecastDocumentLink.user_id, userId))
      .orderBy(desc(documents.doc_date)),
    db
      .select()
      .from(financeForecastStatement)
      .where(eq(financeForecastStatement.user_id, userId))
      .orderBy(sql`${financeForecastStatement.reference_date} DESC NULLS LAST`, desc(financeForecastStatement.id)),
  ]);
  const now = today();

  const items: ItemStatementState[] = [];
  for (const row of itemRows) {
    const contractNo = typeof row.data?.contractNo === "string" ? (row.data.contractNo as string) : null;
    const itemLinks = links.filter((l) => l.itemId === row.id);
    const itemStatements = statements.filter((s) => s.item_id === row.id);
    if (!contractNo && itemLinks.length === 0) continue;
    const latestRow = itemStatements.find((s) => s.status !== "rejected") ?? null;
    const proposals = latestRow && latestRow.status === "proposed" ? computeProposals(row.type, row.data, latestRow.values) : [];
    const lastKnown = itemStatements.find((s) => s.reference_date)?.reference_date ?? null;
    const confirmedLinks = itemLinks.some((l) => l.status === "confirmed");
    items.push({
      itemId: row.id,
      contractNo,
      links: itemLinks.map((l) => ({
        id: l.id,
        documentId: l.documentId,
        title: l.title,
        docDate: l.docDate,
        documentType: l.documentType,
        matchKind: l.matchKind,
        status: l.status,
      })),
      latest: latestRow ? toStatementDto(latestRow) : null,
      proposals,
      history: itemStatements.filter((s) => s.status === "accepted").map(toStatementDto),
      valuesSource: (row.data?.valuesSource as ValuesSource | undefined) ?? null,
      overdue: confirmedLinks && lastKnown != null && monthsBetween(lastKnown, now) > 14,
      reading: reading.has(row.id),
    });
  }
  return { items };
}

