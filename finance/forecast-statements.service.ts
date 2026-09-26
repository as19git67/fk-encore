// Retirement forecast — statements as the source of contract values (#1343).
//
// The logic, without endpoints, so documents' runClassify can call
// onDocumentClassified the way it calls document-match.service.ts. The
// endpoints live in forecast-statements.ts.
//
// Contract items (life insurance, pensions, premiums booked as expenses)
// carry a contract number (data.contractNo). This module
//
//   1. finds the documents that belong to such an item: through the
//      reference tags the documents pipeline writes (versicherungsnr:…,
//      vertragsnr:…), and through the document text, however the number is
//      spaced or dotted there — or the user links one by hand;
//   2. reads the values a statement states (forecast-statements-extract.ts
//      plus the language model when it is reachable);
//   3. offers the differences to the item as correction proposals the user
//      accepts or rejects — nothing is overwritten silently;
//   4. does the same for every new document the moment it is classified.
//
// Only documents the item's owner may see are ever linked. Finance reads the
// documents tables directly, as document-match.service.ts does, but — unlike
// that service — always under the visibility rule of documents/visibility.ts.

import { and, asc, desc, eq, ilike, inArray, like, notInArray, or, sql, type SQL } from "drizzle-orm";

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
  LLM_KIND_FIELD,
  PREMIUM_FIELDS,
  classifyDocument,
  computeProposals,
  contractKey,
  contractPattern,
  parseLlmKind,
  type DocKind,
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
  kind: DocKind;
  kindByUser: boolean;
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
  /** Why a proposal the statement would make is held back (a declined premium increase). */
  notes: string[];
}

export interface DocumentCandidateDto {
  id: number;
  title: string | null;
  docDate: string | null;
  documentType: string | null;
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

/**
 * Visible, readable documents whose text contains the contract number in
 * any spelling (contractPattern), newest first. `skip` are documents the
 * item is already linked to.
 */
async function documentsByText(userId: number, groupIds: number[], key: string, skip: number[]): Promise<number[]> {
  const conds = [
    eq(documents.status, "ready"),
    sql`${documents.extracted_text} ~* ${contractPattern(key)}`,
    visibleTo(userId, groupIds),
  ];
  if (skip.length > 0) conds.push(notInArray(documents.id, skip));
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(...conds))
    .orderBy(sql`${documents.doc_date} DESC NULLS LAST`)
    .limit(20);
  return rows.map((r) => r.id);
}

async function upsertLink(
  userId: number,
  itemId: number,
  documentId: number,
  matchKind: "tag" | "text" | "user",
): Promise<"new-confirmed" | "new-suggested" | "existing"> {
  const status = matchKind === "text" ? "suggested" : "confirmed";
  const inserted = await db
    .insert(financeForecastDocumentLink)
    .values({ user_id: userId, item_id: itemId, document_id: documentId, match_kind: matchKind, status, decided_at: status === "confirmed" ? new Date().toISOString() : null })
    .onConflictDoNothing()
    .returning({ id: financeForecastDocumentLink.id });
  if (inserted.length === 0) {
    // A text suggestion becomes confirmed once the tag shows up — never a rejected one.
    // A link by hand confirms even a rejected one: the user said so.
    if (matchKind === "user") {
      await db
        .update(financeForecastDocumentLink)
        .set({ status: "confirmed", match_kind: "user", decided_at: new Date().toISOString() })
        .where(and(eq(financeForecastDocumentLink.item_id, itemId), eq(financeForecastDocumentLink.document_id, documentId)));
    } else if (matchKind === "tag") {
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
    .select({ text: documents.extracted_text, docDate: documents.doc_date, documentType: documents.document_type })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc?.text) return;

  const regex = parseStatementText(doc.text);
  let llm = null;
  let kind: DocKind = classifyDocument(doc.text, doc.documentType);
  try {
    const raw = await extractStatementValues(
      doc.text,
      { ...LLM_FIELDS, documentKind: LLM_KIND_FIELD },
      {
        itemLabel: item.label,
        contractNo: typeof item.data?.contractNo === "string" ? (item.data.contractNo as string) : null,
      },
    );
    llm = parseLlmStatement(raw);
    // The model reads "you may object" and "we confirm your objection" apart better than a pattern.
    kind = parseLlmKind(raw) ?? kind;
  } catch (err) {
    if (!(err instanceof LlmServiceUnavailableError)) throw err;
    console.warn(`[forecast] statement ${documentId}: language model unavailable, patterns only (${err.message})`);
  }
  // A kind the user set stays; otherwise the recognised one is recorded.
  await db
    .update(financeForecastDocumentLink)
    .set({ doc_kind: kind })
    .where(
      and(
        eq(financeForecastDocumentLink.item_id, itemId),
        eq(financeForecastDocumentLink.document_id, documentId),
        eq(financeForecastDocumentLink.kind_by_user, false),
      ),
    );

  const { values, method } = mergeStatementValues(regex, llm, today());
  if (!values.referenceDate && doc.docDate && /^\d{4}-\d{2}-\d{2}$/.test(doc.docDate)) values.referenceDate = doc.docDate;
  if (!hasAnyValue(values)) return; // a letter without figures — nothing to store

  const proposals = await effectiveProposals(item, { documentId, referenceDate: values.referenceDate, values });
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
    // Also by text when tags were found: letters about a premium increase
    // often carry the number under a label the tags do not know.
    const linked = await db
      .select({ documentId: financeForecastDocumentLink.document_id })
      .from(financeForecastDocumentLink)
      .where(eq(financeForecastDocumentLink.item_id, item.id));
    for (const docId of await documentsByText(userId, groupIds, item.key, linked.map((l) => l.documentId))) {
      if ((await upsertLink(userId, item.id, docId, "text")) === "new-suggested") summary.suggestedByText++;
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
  const [doc] = await db
    .select({ userId: documents.user_id, visibility: documents.visibility, groupId: documents.group_id, text: documents.extracted_text })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc) return;
  const tags = await db
    .select({ name: documentTags.name })
    .from(documentTagLinks)
    .innerJoin(documentTags, eq(documentTags.id, documentTagLinks.tag_id))
    .where(and(eq(documentTagLinks.document_id, documentId), or(...TAG_PREFIXES.map((p) => like(documentTags.name, `${p}%`)))));
  const keys = tags.map((t) => contractKey(t.name.slice(t.name.indexOf(":") + 1))).filter(isSearchableKey);
  if (keys.length === 0 && !doc.text) return;

  const items = (await db.select().from(financeForecastItem)).map(contractItemOf).filter((x): x is ContractItem => x !== null);
  const pairs: Array<{ itemId: number; documentId: number }> = [];
  for (const item of items) {
    const byTag = keys.some((k) => keysMatch(item.key, k));
    const byText = !byTag && !!doc.text && new RegExp(contractPattern(item.key), "i").test(doc.text);
    if (!byTag && !byText) continue;
    const canSee =
      (doc.visibility === "private" && doc.userId === item.userId) ||
      (doc.visibility === "group" && doc.groupId != null && (await groupIdsOf(item.userId)).includes(doc.groupId));
    if (!canSee) continue;
    await upsertLink(item.userId, item.id, documentId, byTag ? "tag" : "text");
    if (byTag) pairs.push({ itemId: item.id, documentId });
  }
  if (pairs.length > 0) await readAll(pairs);
}

/** Visible documents for linking by hand: title or text contains the query, newest first. */
export async function searchDocuments(userId: number, query: string): Promise<DocumentCandidateDto[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const groupIds = await groupIdsOf(userId);
  const key = contractKey(q);
  const byNumber = isSearchableKey(key) ? sql`${documents.extracted_text} ~* ${contractPattern(key)}` : undefined;
  const rows = await db
    .select({ id: documents.id, title: documents.title, docDate: documents.doc_date, documentType: documents.document_type })
    .from(documents)
    .where(
      and(
        eq(documents.status, "ready"),
        visibleTo(userId, groupIds),
        or(ilike(documents.title, pattern), ilike(documents.extracted_text, pattern), ...(byNumber ? [byNumber] : [])),
      ),
    )
    .orderBy(sql`${documents.doc_date} DESC NULLS LAST`)
    .limit(25);
  return rows;
}

/** Links a document to an item by hand (confirmed) and reads it. False when the user may not see it. */
export async function linkByHand(userId: number, itemId: number, documentId: number): Promise<boolean> {
  const groupIds = await groupIdsOf(userId);
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), visibleTo(userId, groupIds)));
  if (!doc) return false;
  await upsertLink(userId, itemId, documentId, "user");
  await readAll([{ itemId, documentId }], true);
  return true;
}

// -----------------------------------------------------------------------
// Which proposals count
// -----------------------------------------------------------------------

interface LinkFacts {
  documentId: number;
  status: "suggested" | "confirmed" | "rejected";
  kind: DocKind;
  docDate: string | null;
}

async function linkFactsOf(itemId: number): Promise<LinkFacts[]> {
  return db
    .select({
      documentId: financeForecastDocumentLink.document_id,
      status: financeForecastDocumentLink.status,
      kind: financeForecastDocumentLink.doc_kind,
      docDate: documents.doc_date,
    })
    .from(financeForecastDocumentLink)
    .innerJoin(documents, eq(documents.id, financeForecastDocumentLink.document_id))
    .where(eq(financeForecastDocumentLink.item_id, itemId));
}

const isoDay = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

/**
 * The declined premium increase that holds a statement's premium back: a
 * confirmed "dynamic_declined" document dated on or after the statement.
 */
function declinedAfter(links: LinkFacts[], st: { documentId: number; referenceDate: string | null }): LinkFacts | null {
  const own = links.find((l) => l.documentId === st.documentId);
  const when = isoDay(own?.docDate) ?? isoDay(st.referenceDate);
  const declined = links
    .filter((l) => l.status === "confirmed" && l.kind === "dynamic_declined" && l.documentId !== st.documentId)
    .filter((l) => {
      const d = isoDay(l.docDate);
      return d != null && (when == null || d >= when);
    })
    .sort((a, b) => (isoDay(b.docDate) ?? "").localeCompare(isoDay(a.docDate) ?? ""));
  return declined[0] ?? null;
}

/** What a statement proposes for an item, less a premium a later declined increase keeps where it is. */
export async function effectiveProposals(
  item: typeof financeForecastItem.$inferSelect,
  st: { documentId: number; referenceDate: string | null; values: ForecastStatementValues },
  links?: LinkFacts[],
): Promise<Proposal[]> {
  const all = computeProposals(item.type, item.data, st.values);
  if (!all.some((p) => PREMIUM_FIELDS.has(p.field))) return all;
  const declined = declinedAfter(links ?? (await linkFactsOf(item.id)), st);
  return declined ? all.filter((p) => !PREMIUM_FIELDS.has(p.field)) : all;
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
        kind: financeForecastDocumentLink.doc_kind,
        kindByUser: financeForecastDocumentLink.kind_by_user,
        title: documents.title,
        docDate: documents.doc_date,
        documentType: documents.document_type,
      })
      .from(financeForecastDocumentLink)
      .innerJoin(documents, eq(documents.id, financeForecastDocumentLink.document_id))
      .where(eq(financeForecastDocumentLink.user_id, userId))
      .orderBy(sql`${documents.doc_date} DESC NULLS LAST`),
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
    // Figures count from statements and announced increases the user has not rejected.
    const counts = (st: (typeof itemStatements)[number]) => {
      const link = itemLinks.find((l) => l.documentId === st.document_id);
      return st.status !== "rejected" && link?.status !== "rejected" && (link?.kind === "statement" || link?.kind === "dynamic_increase");
    };
    const latestRow = itemStatements.find(counts) ?? null;
    const facts: LinkFacts[] = itemLinks.map((l) => ({ documentId: l.documentId, status: l.status, kind: l.kind, docDate: l.docDate }));
    const notes: string[] = [];
    let proposals: Proposal[] = [];
    // "no_change" too: a kind changed since reading can release a held-back premium.
    if (latestRow && (latestRow.status === "proposed" || latestRow.status === "no_change")) {
      const st = { documentId: latestRow.document_id, referenceDate: latestRow.reference_date, values: latestRow.values };
      proposals = await effectiveProposals(row, st, facts);
      const held = computeProposals(row.type, row.data, latestRow.values).length - proposals.length;
      const declined = declinedAfter(facts, st);
      if (held > 0 && declined) {
        const when = isoDay(declined.docDate);
        notes.push(
          `Beitrag nicht vorgeschlagen: die Beitragserhöhung wurde abgelehnt${when ? ` (Schreiben vom ${when.slice(8, 10)}.${when.slice(5, 7)}.${when.slice(0, 4)})` : ""}.`,
        );
      }
    }
    const lastKnown = itemStatements.find((s) => counts(s) && s.reference_date)?.reference_date ?? null;
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
        kind: l.kind,
        kindByUser: l.kindByUser,
      })),
      latest: latestRow ? toStatementDto(latestRow) : null,
      proposals,
      history: itemStatements.filter((s) => s.status === "accepted").map(toStatementDto),
      valuesSource: (row.data?.valuesSource as ValuesSource | undefined) ?? null,
      overdue: confirmedLinks && lastKnown != null && monthsBetween(lastKnown, now) > 14,
      reading: reading.has(row.id),
      notes,
    });
  }
  return { items };
}

