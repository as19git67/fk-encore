// Retirement forecast — endpoints for statements (#1343). The logic is in
// forecast-statements.service.ts.

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  documents,
  financeForecastBookingLink,
  financeForecastDocumentLink,
  financeForecastItem,
  financeForecastStatement,
} from "../db/schema";
import { bookingStates } from "./forecast-bookings.service";
import { DOC_KINDS, VALUE_KINDS, applyProposals, checkUserValues, pickValues, type DocKind } from "./forecast-statements-extract";
import { resolveHousehold } from "./forecast-household.service";
import {
  callerCanOpen,
  declinedDates,
  effectiveProposals,
  linkByHand,
  readAll,
  searchDocuments,
  type DocumentCandidateDto,
  scanForUser,
  statementsForUser,
  toStatementDto,
  type ScanSummary,
  type StatementDto,
  type StatementLinkDto,
  type StatementsResponse,
} from "./forecast-statements.service";

console.log("[boot] finance/forecast-statements.ts: all imports resolved");

interface ScanRequest {
  itemIds?: number[];
}

interface LinkDecisionRequest {
  id: number;
  status: "confirmed" | "rejected";
}

interface AcceptRequest {
  id: number;
  /** Item data keys to take over; all proposals when omitted. */
  fields?: string[];
}

interface IdRequest {
  id: number;
}

interface LinkKindRequest {
  id: number;
  kind: DocKind;
}

interface DocumentSearchRequest {
  q: Query<string>;
}

interface BookingDecisionRequest {
  id: number;
  status: "confirmed" | "rejected";
}

interface ContractNoRequest {
  id: number;
  contractNo: string;
}

interface DeclinedIncreaseRequest {
  id: number;
  /** YYYY-MM-DD: when the increase was declined. */
  date: string;
  /** True takes the date out again. */
  remove?: boolean;
}

/** What a statement says, as the user corrected it. Every field is sent; null clears it. */
interface StatementValuesInput {
  referenceDate: string | null;
  surrenderValue: number | null;
  contractValue: number | null;
  guaranteedPayout: number | null;
  projectedPayout: number | null;
  premiumMonthly: number | null;
  premiumYearly: number | null;
  premiumEndDate: string | null;
  maturityDate: string | null;
  guaranteedMonthlyPension: number | null;
  projectedMonthlyPension: number | null;
  lumpSum: number | null;
  pensionStartDate: string | null;
}

interface CorrectValuesRequest {
  id: number;
  values: StatementValuesInput;
}

interface ManualLinkRequest {
  id: number;
  documentId: number;
}

async function linkDto(row: typeof financeForecastDocumentLink.$inferSelect, callerId: number): Promise<StatementLinkDto> {
  const [doc] = await db
    .select({ title: documents.title, docDate: documents.doc_date, documentType: documents.document_type })
    .from(documents)
    .where(eq(documents.id, row.document_id));
  return {
    id: row.id,
    documentId: row.document_id,
    title: doc?.title ?? null,
    docDate: doc?.docDate ?? null,
    documentType: doc?.documentType ?? null,
    matchKind: row.match_kind,
    status: row.status,
    kind: row.doc_kind,
    kindByUser: row.kind_by_user,
    canOpen: doc != null && (await callerCanOpen(callerId, row.document_id)),
  };
}

// -----------------------------------------------------------------------
// API
// -----------------------------------------------------------------------

/** The caller's household: `userId` owns the rows, `callerId` asks. "edit" refuses a read-only share. */
async function authed(mode: "view" | "edit"): Promise<{ userId: number; callerId: number }> {
  const auth = getAuthData()!;
  requirePermission(auth, "finance.view");
  const access = await resolveHousehold(Number(auth.userID), auth.permissions.includes("finance.admin"));
  if (mode === "edit" && access.role === "view") throw APIError.permissionDenied("this forecast is shared with you read-only");
  return { userId: access.ownerId, callerId: access.callerId };
}

export const getStatements = api(
  { expose: true, method: "GET", path: "/finance/forecast/statements", auth: true },
  async (): Promise<StatementsResponse> => {
    const { userId, callerId } = await authed("view");
    return statementsForUser(userId, callerId);
  },
);

export const scanStatements = api(
  { expose: true, method: "POST", path: "/finance/forecast/statements/scan", auth: true },
  async (req: ScanRequest): Promise<ScanSummary> => {
    const { userId, callerId } = await authed("edit");
    return scanForUser(userId, Array.isArray(req.itemIds) ? req.itemIds.filter((n) => Number.isInteger(n)) : null);
  },
);

export const decideStatementLink = api(
  { expose: true, method: "POST", path: "/finance/forecast/statement-links/:id/decision", auth: true },
  async (req: LinkDecisionRequest): Promise<StatementLinkDto> => {
    const { userId, callerId } = await authed("edit");
    if (req.status !== "confirmed" && req.status !== "rejected") throw APIError.invalidArgument("status must be confirmed or rejected");
    const [row] = await db
      .update(financeForecastDocumentLink)
      .set({ status: req.status, decided_at: new Date().toISOString() })
      .where(and(eq(financeForecastDocumentLink.id, req.id), eq(financeForecastDocumentLink.user_id, userId)))
      .returning();
    if (!row) throw APIError.notFound(`link ${req.id} not found`);
    if (req.status === "confirmed") void readAll([{ itemId: row.item_id, documentId: row.document_id }]);
    else {
      // What a rejected document said is no longer a proposal.
      await db
        .update(financeForecastStatement)
        .set({ status: "rejected", decided_at: new Date().toISOString() })
        .where(
          and(
            eq(financeForecastStatement.item_id, row.item_id),
            eq(financeForecastStatement.document_id, row.document_id),
            eq(financeForecastStatement.status, "proposed"),
          ),
        );
    }
    return linkDto(row, callerId);
  },
);

export const setStatementLinkKind = api(
  { expose: true, method: "POST", path: "/finance/forecast/statement-links/:id/kind", auth: true },
  async (req: LinkKindRequest): Promise<StatementLinkDto> => {
    const { userId, callerId } = await authed("edit");
    if (!DOC_KINDS.includes(req.kind)) throw APIError.invalidArgument(`kind must be one of ${DOC_KINDS.join(", ")}`);
    const [row] = await db
      .update(financeForecastDocumentLink)
      .set({ doc_kind: req.kind, kind_by_user: true })
      .where(and(eq(financeForecastDocumentLink.id, req.id), eq(financeForecastDocumentLink.user_id, userId)))
      .returning();
    if (!row) throw APIError.notFound(`link ${req.id} not found`);
    // A document now counted as a statement may never have been read.
    if (row.status === "confirmed" && VALUE_KINDS.has(req.kind)) {
      void readAll([{ itemId: row.item_id, documentId: row.document_id }]);
    }
    return linkDto(row, callerId);
  },
);

export const searchStatementDocuments = api(
  { expose: true, method: "GET", path: "/finance/forecast/statement-documents", auth: true },
  async (req: DocumentSearchRequest): Promise<{ documents: DocumentCandidateDto[] }> => {
    const { userId, callerId } = await authed("view");
    void userId;
    // Only what the caller may see: a partner's private documents are not searchable.
    return { documents: await searchDocuments(callerId, req.q ?? "") };
  },
);

export const linkStatementDocument = api(
  { expose: true, method: "POST", path: "/finance/forecast/items/:id/statement-links", auth: true },
  async (req: ManualLinkRequest): Promise<void> => {
    const { userId, callerId } = await authed("edit");
    const [item] = await db
      .select({ id: financeForecastItem.id })
      .from(financeForecastItem)
      .where(and(eq(financeForecastItem.id, req.id), eq(financeForecastItem.user_id, userId)));
    if (!item) throw APIError.notFound(`item ${req.id} not found`);
    if (!(await linkByHand(userId, callerId, req.id, req.documentId))) throw APIError.notFound(`document ${req.documentId} not found`);
  },
);

export const rereadStatementLink = api(
  { expose: true, method: "POST", path: "/finance/forecast/statement-links/:id/reread", auth: true },
  async (req: IdRequest): Promise<void> => {
    const { userId, callerId } = await authed("edit");
    const [row] = await db
      .select()
      .from(financeForecastDocumentLink)
      .where(and(eq(financeForecastDocumentLink.id, req.id), eq(financeForecastDocumentLink.user_id, userId)));
    if (!row) throw APIError.notFound(`link ${req.id} not found`);
    if (row.status !== "confirmed") throw APIError.failedPrecondition("confirm the document first");
    await readAll([{ itemId: row.item_id, documentId: row.document_id }], true);
  },
);

export const acceptStatement = api(
  { expose: true, method: "POST", path: "/finance/forecast/statements/:id/accept", auth: true },
  async (req: AcceptRequest): Promise<StatementDto> => {
    const { userId, callerId } = await authed("edit");
    const [st] = await db
      .select()
      .from(financeForecastStatement)
      .where(and(eq(financeForecastStatement.id, req.id), eq(financeForecastStatement.user_id, userId)));
    if (!st) throw APIError.notFound(`statement ${req.id} not found`);
    const [item] = await db.select().from(financeForecastItem).where(eq(financeForecastItem.id, st.item_id));
    if (!item) throw APIError.notFound(`item ${st.item_id} not found`);

    const all = await effectiveProposals(item, { documentId: st.document_id, referenceDate: st.reference_date, values: st.values });
    const wanted = req.fields && req.fields.length > 0 ? all.filter((p) => req.fields!.includes(p.field)) : all;
    const now = new Date().toISOString();
    const data = applyProposals(item.data, wanted, { documentId: st.document_id, referenceDate: st.reference_date, now });
    await db.update(financeForecastItem).set({ data, updated_at: now }).where(eq(financeForecastItem.id, item.id));
    // Fully taken over when nothing is left to propose.
    const left = (await effectiveProposals({ ...item, data }, { documentId: st.document_id, referenceDate: st.reference_date, values: st.values })).length;
    const [updated] = await db
      .update(financeForecastStatement)
      .set({ status: left === 0 ? "accepted" : "proposed", decided_at: now })
      .where(eq(financeForecastStatement.id, st.id))
      .returning();
    return toStatementDto(updated);
  },
);

export const rejectStatement = api(
  { expose: true, method: "POST", path: "/finance/forecast/statements/:id/reject", auth: true },
  async (req: IdRequest): Promise<StatementDto> => {
    const { userId, callerId } = await authed("edit");
    const [updated] = await db
      .update(financeForecastStatement)
      .set({ status: "rejected", decided_at: new Date().toISOString() })
      .where(and(eq(financeForecastStatement.id, req.id), eq(financeForecastStatement.user_id, userId)))
      .returning();
    if (!updated) throw APIError.notFound(`statement ${req.id} not found`);
    return toStatementDto(updated);
  },
);

export const setDeclinedIncrease = api(
  { expose: true, method: "POST", path: "/finance/forecast/items/:id/declined-increases", auth: true },
  async (req: DeclinedIncreaseRequest): Promise<{ declinedWithoutDocument: string[] }> => {
    const { userId, callerId } = await authed("edit");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.date ?? "")) throw APIError.invalidArgument("date must be YYYY-MM-DD");
    const [item] = await db
      .select()
      .from(financeForecastItem)
      .where(and(eq(financeForecastItem.id, req.id), eq(financeForecastItem.user_id, userId)));
    if (!item) throw APIError.notFound(`item ${req.id} not found`);
    const dates = new Set(declinedDates(item.data));
    if (req.remove) dates.delete(req.date);
    else dates.add(req.date);
    const next = [...dates].sort();
    await db
      .update(financeForecastItem)
      .set({ data: { ...item.data, declinedIncreases: next }, updated_at: new Date().toISOString() })
      .where(eq(financeForecastItem.id, item.id));
    return { declinedWithoutDocument: next };
  },
);

export const correctStatementValues = api(
  { expose: true, method: "POST", path: "/finance/forecast/statements/:id/values", auth: true },
  async (req: CorrectValuesRequest): Promise<StatementDto> => {
    const { userId, callerId } = await authed("edit");
    const values = pickValues((req.values ?? {}) as unknown as Record<string, unknown>);
    const bad = checkUserValues(values);
    if (bad.length > 0) throw APIError.invalidArgument(`implausible values: ${bad.join(", ")}`);
    const [st] = await db
      .select()
      .from(financeForecastStatement)
      .where(and(eq(financeForecastStatement.id, req.id), eq(financeForecastStatement.user_id, userId)));
    if (!st) throw APIError.notFound(`statement ${req.id} not found`);
    const [item] = await db.select().from(financeForecastItem).where(eq(financeForecastItem.id, st.item_id));
    if (!item) throw APIError.notFound(`item ${st.item_id} not found`);
    const proposals = await effectiveProposals(item, { documentId: st.document_id, referenceDate: values.referenceDate, values });
    const [updated] = await db
      .update(financeForecastStatement)
      .set({
        values,
        reference_date: values.referenceDate,
        method: "user",
        status: proposals.length > 0 ? "proposed" : "no_change",
        decided_at: null,
      })
      .where(eq(financeForecastStatement.id, st.id))
      .returning();
    return toStatementDto(updated);
  },
);

// -----------------------------------------------------------------------
// Bookings (migration 0216)
// -----------------------------------------------------------------------

export const decideBookingLink = api(
  { expose: true, method: "POST", path: "/finance/forecast/booking-links/:id/decision", auth: true },
  async (req: BookingDecisionRequest): Promise<void> => {
    const { userId } = await authed("edit");
    if (req.status !== "confirmed" && req.status !== "rejected") throw APIError.invalidArgument("status must be confirmed or rejected");
    const [row] = await db
      .update(financeForecastBookingLink)
      .set({ status: req.status, decided_at: new Date().toISOString() })
      .where(and(eq(financeForecastBookingLink.id, req.id), eq(financeForecastBookingLink.user_id, userId)))
      .returning({ id: financeForecastBookingLink.id });
    if (!row) throw APIError.notFound(`booking link ${req.id} not found`);
  },
);

/** Takes over the premium the confirmed bookings say. */
export const acceptBookingPremium = api(
  { expose: true, method: "POST", path: "/finance/forecast/items/:id/booking-premium", auth: true },
  async (req: IdRequest): Promise<void> => {
    const { userId } = await authed("edit");
    const [item] = await db
      .select()
      .from(financeForecastItem)
      .where(and(eq(financeForecastItem.id, req.id), eq(financeForecastItem.user_id, userId)));
    if (!item) throw APIError.notFound(`item ${req.id} not found`);
    const state = (await bookingStates([item])).get(item.id);
    const p = state?.proposal;
    if (!p) throw APIError.failedPrecondition("the bookings propose no premium for this item");
    const now = new Date().toISOString();
    const data = { ...item.data, [p.field]: p.proposed, valuesSource: { kind: "booking", updatedAt: now } };
    await db.update(financeForecastItem).set({ data, updated_at: now }).where(eq(financeForecastItem.id, item.id));
  },
);

/** Sets the item's contract number (e.g. the one a booking's mandate reference names) and searches again. */
export const setItemContractNo = api(
  { expose: true, method: "POST", path: "/finance/forecast/items/:id/contract-no", auth: true },
  async (req: ContractNoRequest): Promise<ScanSummary> => {
    const { userId } = await authed("edit");
    const no = (req.contractNo ?? "").trim();
    if (no.length < 4 || no.length > 60) throw APIError.invalidArgument("contract number must be 4 to 60 characters");
    const [item] = await db
      .select()
      .from(financeForecastItem)
      .where(and(eq(financeForecastItem.id, req.id), eq(financeForecastItem.user_id, userId)));
    if (!item) throw APIError.notFound(`item ${req.id} not found`);
    await db
      .update(financeForecastItem)
      .set({ data: { ...item.data, contractNo: no }, updated_at: new Date().toISOString() })
      .where(eq(financeForecastItem.id, item.id));
    return scanForUser(userId, [item.id]);
  },
);
