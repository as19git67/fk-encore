// Retirement forecast — bookings that pay a contract item's premium (migration 0216).
//
// A booking belongs to an item when it names the contract number (purpose
// or SEPA mandate reference), when it is already linked to one of the
// item's confirmed documents, or — as a suggestion — when its counterparty
// names the insurer and its amount fits the premium. Only bookings on
// accounts someone in the owner's household may see are considered. No
// endpoints here; forecast-statements.ts serves them.

import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeForecastBookingLink,
  financeForecastDocumentLink,
  financeForecastItem,
  financeTransaction,
  financeTransactionDocument,
} from "../db/schema";
import { getPermissionsForUser } from "../user/user.service";
import { householdMemberIds } from "./forecast-household.service";
import {
  bookingProposal,
  expectedPerYear,
  fitsPremium,
  isInsuranceItem,
  nameTokens,
  summarizeBookings,
  type BookingSummary,
} from "./forecast-bookings-extract";
import { contractKey, contractPattern, isSearchableKey, type Proposal } from "./forecast-statements-extract";

console.log("[boot] finance/forecast-bookings.service.ts: all imports resolved");

export interface BookingLinkDto {
  id: number;
  transactionId: number;
  date: string;
  amount: number;
  counterparty: string | null;
  purpose: string | null;
  matchKind: "contract" | "document" | "counterparty" | "user";
  status: "suggested" | "confirmed" | "rejected";
}

export interface ItemBookingState {
  bookings: BookingLinkDto[];
  /** From the confirmed bookings. */
  summary: BookingSummary | null;
  /** The premium the bookings say, where it differs from the item. */
  proposal: Proposal | null;
  /** A contract number found in the mandate reference of a confirmed booking, for an item without one. */
  contractNoSuggestion: string | null;
}

/** How far back bookings are looked for. */
const MONTHS_BACK = 24;

function since(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - MONTHS_BACK);
  return d.toISOString().slice(0, 10);
}

/** Accounts anyone in the owner's household may see; finance admins see all. */
export async function householdAccountIds(ownerId: number): Promise<number[]> {
  const members = await householdMemberIds(ownerId);
  for (const id of members) {
    if ((await getPermissionsForUser(id)).includes("finance.admin")) {
      return (await db.select({ id: financeAccount.id }).from(financeAccount)).map((r) => r.id);
    }
  }
  const rows = await db
    .selectDistinct({ id: financeAccountAccess.account_id })
    .from(financeAccountAccess)
    .where(inArray(financeAccountAccess.user_id, members));
  return rows.map((r) => r.id);
}

async function upsertBookingLink(
  ownerId: number,
  itemId: number,
  transactionId: number,
  matchKind: BookingLinkDto["matchKind"],
): Promise<"new-confirmed" | "new-suggested" | "existing"> {
  const status = matchKind === "counterparty" ? "suggested" : "confirmed";
  const inserted = await db
    .insert(financeForecastBookingLink)
    .values({
      user_id: ownerId,
      item_id: itemId,
      transaction_id: transactionId,
      match_kind: matchKind,
      status,
      decided_at: status === "confirmed" ? new Date().toISOString() : null,
    })
    .onConflictDoNothing()
    .returning({ id: financeForecastBookingLink.id });
  if (inserted.length > 0) return status === "confirmed" ? "new-confirmed" : "new-suggested";
  // A stronger reason confirms a suggestion — never a rejected link.
  if (status === "confirmed") {
    await db
      .update(financeForecastBookingLink)
      .set({ status: "confirmed", match_kind: matchKind, decided_at: new Date().toISOString() })
      .where(
        and(
          eq(financeForecastBookingLink.item_id, itemId),
          eq(financeForecastBookingLink.transaction_id, transactionId),
          eq(financeForecastBookingLink.status, "suggested"),
        ),
      );
  }
  return "existing";
}

export interface BookingScanSummary {
  bookingsLinked: number;
  bookingsSuggested: number;
}

/** Links the insurance items' bookings. `itemIds` null scans every item of the owner. */
export async function scanBookings(ownerId: number, itemIds: number[] | null): Promise<BookingScanSummary> {
  const summary: BookingScanSummary = { bookingsLinked: 0, bookingsSuggested: 0 };
  const rows = await db
    .select()
    .from(financeForecastItem)
    .where(
      itemIds && itemIds.length > 0
        ? and(eq(financeForecastItem.user_id, ownerId), inArray(financeForecastItem.id, itemIds))
        : eq(financeForecastItem.user_id, ownerId),
    );
  const items = rows.filter((r) => isInsuranceItem(r.type, r.label, r.data));
  if (items.length === 0) return summary;
  const accountIds = await householdAccountIds(ownerId);
  if (accountIds.length === 0) return summary;
  const base: SQL[] = [
    inArray(financeTransaction.account_id, accountIds),
    lt(financeTransaction.amount, "0"),
    gte(financeTransaction.booking_date, since()),
  ];

  for (const item of items) {
    const count = (r: string) => {
      if (r === "new-confirmed") summary.bookingsLinked++;
      if (r === "new-suggested") summary.bookingsSuggested++;
    };
    // 1. The contract number in the purpose or the mandate reference.
    const no = typeof item.data.contractNo === "string" ? item.data.contractNo : "";
    const key = contractKey(no);
    if (isSearchableKey(key)) {
      const pattern = contractPattern(key);
      const txs = await db
        .select({ id: financeTransaction.id })
        .from(financeTransaction)
        .where(and(...base, or(sql`${financeTransaction.purpose} ~* ${pattern}`, sql`${financeTransaction.mandate_ref} ~* ${pattern}`)))
        .limit(100);
      for (const t of txs) count(await upsertBookingLink(ownerId, item.id, t.id, "contract"));
    }
    // 2. Bookings already linked to one of the item's confirmed documents.
    const viaDocs = await db
      .select({ id: financeTransactionDocument.transaction_id })
      .from(financeTransactionDocument)
      .innerJoin(financeForecastDocumentLink, eq(financeForecastDocumentLink.document_id, financeTransactionDocument.document_id))
      .innerJoin(financeTransaction, eq(financeTransaction.id, financeTransactionDocument.transaction_id))
      .where(
        and(
          eq(financeForecastDocumentLink.item_id, item.id),
          eq(financeForecastDocumentLink.status, "confirmed"),
          inArray(financeTransaction.account_id, accountIds),
        ),
      );
    for (const t of viaDocs) count(await upsertBookingLink(ownerId, item.id, t.id, "document"));

    // 3. Without a confirmed booking: the insurer in the counterparty and an amount that fits.
    const [confirmed] = await db
      .select({ id: financeForecastBookingLink.id })
      .from(financeForecastBookingLink)
      .where(and(eq(financeForecastBookingLink.item_id, item.id), eq(financeForecastBookingLink.status, "confirmed")))
      .limit(1);
    if (confirmed) continue;
    const tokens = nameTokens(item.data.insurer, item.label);
    const perYear = expectedPerYear(item.type, item.data);
    if (tokens.length === 0 || perYear == null) continue;
    const txs = await db
      .select({ id: financeTransaction.id, amount: financeTransaction.amount })
      .from(financeTransaction)
      .where(and(...base, or(...tokens.map((t) => ilike(financeTransaction.counterparty, `%${t}%`)))))
      .orderBy(desc(financeTransaction.booking_date))
      .limit(60);
    const fitting = txs.filter((t) => fitsPremium(Number(t.amount), perYear));
    // One lucky hit is not a premium; a repeating one is.
    if (fitting.length < 2) continue;
    for (const t of fitting.slice(0, 24)) count(await upsertBookingLink(ownerId, item.id, t.id, "counterparty"));
  }
  return summary;
}

/** Linked bookings and what they say, per item. */
export async function bookingStates(
  items: Array<typeof financeForecastItem.$inferSelect>,
): Promise<Map<number, ItemBookingState>> {
  const out = new Map<number, ItemBookingState>();
  if (items.length === 0) return out;
  const rows = await db
    .select({
      id: financeForecastBookingLink.id,
      itemId: financeForecastBookingLink.item_id,
      transactionId: financeForecastBookingLink.transaction_id,
      matchKind: financeForecastBookingLink.match_kind,
      status: financeForecastBookingLink.status,
      date: financeTransaction.booking_date,
      amount: financeTransaction.amount,
      counterparty: financeTransaction.counterparty,
      purpose: financeTransaction.purpose,
      mandateRef: financeTransaction.mandate_ref,
    })
    .from(financeForecastBookingLink)
    .innerJoin(financeTransaction, eq(financeTransaction.id, financeForecastBookingLink.transaction_id))
    .where(inArray(financeForecastBookingLink.item_id, items.map((i) => i.id)))
    .orderBy(desc(financeTransaction.booking_date));
  for (const item of items) {
    const mine = rows.filter((r) => r.itemId === item.id);
    const confirmed = mine.filter((r) => r.status === "confirmed");
    const summary = summarizeBookings(confirmed.map((r) => ({ date: r.date, amount: Number(r.amount) })));
    let contractNoSuggestion: string | null = null;
    if (!(typeof item.data.contractNo === "string" && item.data.contractNo.trim())) {
      const refs = confirmed.map((r) => r.mandateRef?.trim()).filter((r): r is string => !!r && isSearchableKey(contractKey(r)));
      const freq = new Map<string, number>();
      for (const r of refs) freq.set(r, (freq.get(r) ?? 0) + 1);
      contractNoSuggestion = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    out.set(item.id, {
      bookings: mine
        .filter((r) => r.status !== "rejected")
        .map((r) => ({
          id: r.id,
          transactionId: r.transactionId,
          date: r.date.slice(0, 10),
          amount: Number(r.amount),
          counterparty: r.counterparty,
          purpose: r.purpose ? r.purpose.slice(0, 140) : null,
          matchKind: r.matchKind,
          status: r.status,
        })),
      summary,
      proposal: bookingProposal(item.type, item.data, summary),
      contractNoSuggestion,
    });
  }
  return out;
}
