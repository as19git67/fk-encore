/**
 * The securities master of a depot (.claude/plans/wertpapier-stamm.md,
 * stage 1).
 *
 * A security is booked into a depot only once it is *confirmed* there.
 * What the bank's holdings deliver is confirmed by itself; a security
 * known only from a booking's text or a paper is a *proposal* — the
 * review page shows it with its evidence, and the user takes it in or
 * ignores it. Derivation and document enrichment ask `admitSecurity`
 * before they create a row, and an ignored security stays silent.
 *
 * Keyed per depot and identifier (ISIN, else WKN): the same fund in two
 * depots is two entries, each decided on its own.
 */

import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import db from "../db/database";
import { financeDepotSecurity, financeDepotSecurityEvidence } from "../db/schema";

console.log("[boot] finance/depot-securities.ts: all imports resolved");

export type SecurityStatus = "confirmed" | "proposed" | "ignored";
export type SecuritySource = "bank" | "booking" | "document" | "user";

export interface SecurityIds {
  isin: string | null;
  wkn: string | null;
  name: string | null;
}

export interface SecurityEvidence {
  transactionId?: number;
  documentId?: number;
}

type SecurityRow = typeof financeDepotSecurity.$inferSelect;

/** The depot's entry for this ISIN or WKN, if any. */
export async function findSecurity(accountId: number, ids: Pick<SecurityIds, "isin" | "wkn">): Promise<SecurityRow | null> {
  const matches = [];
  if (ids.isin) matches.push(eq(financeDepotSecurity.isin, ids.isin));
  if (ids.wkn) matches.push(eq(financeDepotSecurity.wkn, ids.wkn));
  if (matches.length === 0) return null;
  const [row] = await db
    .select()
    .from(financeDepotSecurity)
    .where(and(eq(financeDepotSecurity.account_id, accountId), or(...matches)!))
    // An entry that carries both identifiers over one with a single one.
    .orderBy(desc(sql`(${financeDepotSecurity.isin} IS NOT NULL)::int + (${financeDepotSecurity.wkn} IS NOT NULL)::int`))
    .limit(1);
  return row ?? null;
}

async function addEvidence(securityId: number, evidence: SecurityEvidence | undefined): Promise<void> {
  if (!evidence || (evidence.transactionId === undefined && evidence.documentId === undefined)) return;
  await db
    .insert(financeDepotSecurityEvidence)
    .values({
      security_id: securityId,
      transaction_id: evidence.transactionId ?? null,
      document_id: evidence.documentId ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Whether the security may be booked into the depot, recording it on the
 * way: a security the bank holds (`source` "bank") is confirmed, or
 * promoted from a proposal; one met in a booking or a paper is proposed
 * with that evidence, until the user decides. Without an identifier there
 * is nothing to keep — a holding matched by its name counts as the
 * bank's word.
 */
export async function admitSecurity(
  accountId: number,
  ids: SecurityIds,
  source: Exclude<SecuritySource, "user">,
  evidence?: SecurityEvidence,
): Promise<SecurityStatus> {
  if (!ids.isin && !ids.wkn) return "confirmed";
  const existing = await findSecurity(accountId, ids);
  if (existing) {
    // The bank holds what was only proposed so far: that settles it. An
    // ignored one stays ignored — the user said so.
    if (source === "bank" && existing.status === "proposed") {
      await db
        .update(financeDepotSecurity)
        .set({ status: "confirmed", source: "bank", decided_at: new Date().toISOString() })
        .where(eq(financeDepotSecurity.id, existing.id));
      return "confirmed";
    }
    // Fill in an identifier or a name the entry lacks.
    const patch: Partial<typeof financeDepotSecurity.$inferInsert> = {};
    if (existing.isin === null && ids.isin) patch.isin = ids.isin;
    if (existing.wkn === null && ids.wkn) patch.wkn = ids.wkn;
    if (existing.name === null && ids.name) patch.name = ids.name;
    if (Object.keys(patch).length > 0) {
      await db.update(financeDepotSecurity).set(patch).where(eq(financeDepotSecurity.id, existing.id)).catch(() => {});
    }
    if (existing.status === "proposed") await addEvidence(existing.id, evidence);
    return existing.status as SecurityStatus;
  }
  const status: SecurityStatus = source === "bank" ? "confirmed" : "proposed";
  const [inserted] = await db
    .insert(financeDepotSecurity)
    .values({
      account_id: accountId,
      isin: ids.isin,
      wkn: ids.wkn,
      name: ids.name,
      status,
      source,
      decided_at: status === "confirmed" ? new Date().toISOString() : null,
    })
    .onConflictDoNothing()
    .returning({ id: financeDepotSecurity.id });
  if (!inserted) {
    // Inserted meanwhile: ask again.
    return (await findSecurity(accountId, ids))?.status as SecurityStatus ?? "proposed";
  }
  if (status === "proposed") await addEvidence(inserted.id, evidence);
  return status;
}

/** Every security of a holdings snapshot is the bank's word: confirmed. */
export async function confirmBankSecurities(
  accountId: number,
  holdings: Array<{ isin: string | null; wkn: string | null; name: string | null }>,
): Promise<void> {
  for (const h of holdings) {
    if (!h.isin && !h.wkn) continue;
    await admitSecurity(accountId, { isin: h.isin, wkn: h.wkn, name: h.name }, "bank");
  }
}

export type SecurityDecision = "confirm" | "ignore" | "propose";

/** The user's word on a proposal — or on a decision to undo ("propose"). */
export async function decideSecurity(id: number, decision: SecurityDecision, userId: number): Promise<SecurityRow | null> {
  const status: SecurityStatus = decision === "confirm" ? "confirmed" : decision === "ignore" ? "ignored" : "proposed";
  const [row] = await db
    .update(financeDepotSecurity)
    .set({ status, source: "user", decided_at: new Date().toISOString(), decided_by: userId })
    .where(eq(financeDepotSecurity.id, id))
    .returning();
  return row ?? null;
}

export interface ListedSecurity {
  id: number;
  account_id: number;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  status: SecurityStatus;
  source: SecuritySource;
  first_seen_at: string;
  /** Bookings and papers the proposal was met in. */
  bookings: number;
  documents: number;
  /** The documents, for the review page's links (newest first, at most a few). */
  document_ids: number[];
}

/** Proposals (and, on request, ignored securities) of these depots, with their evidence. */
export async function listSecurities(
  accountIds: number[],
  statuses: SecurityStatus[],
): Promise<ListedSecurity[]> {
  if (accountIds.length === 0 || statuses.length === 0) return [];
  const rows = await db
    .select()
    .from(financeDepotSecurity)
    .where(and(inArray(financeDepotSecurity.account_id, accountIds), inArray(financeDepotSecurity.status, statuses)))
    .orderBy(desc(financeDepotSecurity.first_seen_at));
  if (rows.length === 0) return [];
  const evidence = await db
    .select({
      security_id: financeDepotSecurityEvidence.security_id,
      transaction_id: financeDepotSecurityEvidence.transaction_id,
      document_id: financeDepotSecurityEvidence.document_id,
    })
    .from(financeDepotSecurityEvidence)
    .where(inArray(financeDepotSecurityEvidence.security_id, rows.map((r) => r.id)))
    .orderBy(desc(financeDepotSecurityEvidence.seen_at));
  const byId = new Map<number, { bookings: number; documents: number; docs: number[] }>();
  for (const e of evidence) {
    const agg = byId.get(e.security_id) ?? { bookings: 0, documents: 0, docs: [] };
    if (e.transaction_id !== null) agg.bookings++;
    if (e.document_id !== null) {
      agg.documents++;
      if (agg.docs.length < 5) agg.docs.push(e.document_id);
    }
    byId.set(e.security_id, agg);
  }
  return rows.map((r) => {
    const agg = byId.get(r.id) ?? { bookings: 0, documents: 0, docs: [] };
    return {
      id: r.id,
      account_id: r.account_id,
      isin: r.isin,
      wkn: r.wkn,
      name: r.name,
      status: r.status as SecurityStatus,
      source: r.source as SecuritySource,
      first_seen_at: new Date(r.first_seen_at).toISOString(),
      bookings: agg.bookings,
      documents: agg.documents,
      document_ids: agg.docs,
    };
  });
}

/** The documents a proposal was met in — read again once it is confirmed. */
export async function evidenceDocumentIds(securityId: number): Promise<number[]> {
  const rows = await db
    .select({ id: financeDepotSecurityEvidence.document_id })
    .from(financeDepotSecurityEvidence)
    .where(and(eq(financeDepotSecurityEvidence.security_id, securityId), isNotNull(financeDepotSecurityEvidence.document_id)));
  return rows.map((r) => r.id!);
}
