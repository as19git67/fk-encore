// Retirement forecast — endpoints for statements (#1343). The logic is in
// forecast-statements.service.ts.

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { documents, financeForecastDocumentLink, financeForecastItem, financeForecastStatement } from "../db/schema";
import { DOC_KINDS, applyProposals, type DocKind } from "./forecast-statements-extract";
import {
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

interface ManualLinkRequest {
  id: number;
  documentId: number;
}

async function linkDto(row: typeof financeForecastDocumentLink.$inferSelect): Promise<StatementLinkDto> {
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
  };
}

// -----------------------------------------------------------------------
// API
// -----------------------------------------------------------------------

function authed(): number {
  const auth = getAuthData()!;
  requirePermission(auth, "finance.view");
  return Number(auth.userID);
}

export const getStatements = api(
  { expose: true, method: "GET", path: "/finance/forecast/statements", auth: true },
  async (): Promise<StatementsResponse> => statementsForUser(authed()),
);

export const scanStatements = api(
  { expose: true, method: "POST", path: "/finance/forecast/statements/scan", auth: true },
  async (req: ScanRequest): Promise<ScanSummary> => {
    const userId = authed();
    return scanForUser(userId, Array.isArray(req.itemIds) ? req.itemIds.filter((n) => Number.isInteger(n)) : null);
  },
);

export const decideStatementLink = api(
  { expose: true, method: "POST", path: "/finance/forecast/statement-links/:id/decision", auth: true },
  async (req: LinkDecisionRequest): Promise<StatementLinkDto> => {
    const userId = authed();
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
    return linkDto(row);
  },
);

export const setStatementLinkKind = api(
  { expose: true, method: "POST", path: "/finance/forecast/statement-links/:id/kind", auth: true },
  async (req: LinkKindRequest): Promise<StatementLinkDto> => {
    const userId = authed();
    if (!DOC_KINDS.includes(req.kind)) throw APIError.invalidArgument(`kind must be one of ${DOC_KINDS.join(", ")}`);
    const [row] = await db
      .update(financeForecastDocumentLink)
      .set({ doc_kind: req.kind, kind_by_user: true })
      .where(and(eq(financeForecastDocumentLink.id, req.id), eq(financeForecastDocumentLink.user_id, userId)))
      .returning();
    if (!row) throw APIError.notFound(`link ${req.id} not found`);
    // A document now counted as a statement may never have been read.
    if (row.status === "confirmed" && (req.kind === "statement" || req.kind === "dynamic_increase")) {
      void readAll([{ itemId: row.item_id, documentId: row.document_id }]);
    }
    return linkDto(row);
  },
);

export const searchStatementDocuments = api(
  { expose: true, method: "GET", path: "/finance/forecast/statement-documents", auth: true },
  async (req: DocumentSearchRequest): Promise<{ documents: DocumentCandidateDto[] }> => {
    const userId = authed();
    return { documents: await searchDocuments(userId, req.q ?? "") };
  },
);

export const linkStatementDocument = api(
  { expose: true, method: "POST", path: "/finance/forecast/items/:id/statement-links", auth: true },
  async (req: ManualLinkRequest): Promise<void> => {
    const userId = authed();
    const [item] = await db
      .select({ id: financeForecastItem.id })
      .from(financeForecastItem)
      .where(and(eq(financeForecastItem.id, req.id), eq(financeForecastItem.user_id, userId)));
    if (!item) throw APIError.notFound(`item ${req.id} not found`);
    if (!(await linkByHand(userId, req.id, req.documentId))) throw APIError.notFound(`document ${req.documentId} not found`);
  },
);

export const rereadStatementLink = api(
  { expose: true, method: "POST", path: "/finance/forecast/statement-links/:id/reread", auth: true },
  async (req: IdRequest): Promise<void> => {
    const userId = authed();
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
    const userId = authed();
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
    const userId = authed();
    const [updated] = await db
      .update(financeForecastStatement)
      .set({ status: "rejected", decided_at: new Date().toISOString() })
      .where(and(eq(financeForecastStatement.id, req.id), eq(financeForecastStatement.user_id, userId)))
      .returning();
    if (!updated) throw APIError.notFound(`statement ${req.id} not found`);
    return toStatementDto(updated);
  },
);
