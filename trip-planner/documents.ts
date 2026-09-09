/**
 * The paperwork a trip actually runs on (§3.4).
 *
 * §3.4 is one of the four reasons this planner can do something Google
 * structurally cannot: the hotel confirmation, the train ticket, the
 * rental agreement and the booked museum slot are already in the house,
 * already OCR'd, already classified. The plan should be built around
 * those real fixed points — check-in from 15:00, the car back by ten,
 * the last train at 17:45 — instead of around a guess.
 *
 * Until now nothing connected the two halves: documents hung off a
 * user, never off a trip, which is exactly why §8.6's readiness check
 * had to answer "Tickets und Buchungen kann die App noch nicht prüfen".
 * This module is that connection, and it is deliberately thin.
 *
 * Four decisions worth stating:
 *
 *   - **Suggested, never taken.** §8.2: "Nichts wird stillschweigend
 *     angenommen. Erkannte Dokumente werden vorgeschlagen." A document
 *     is offered with the reason it was offered for — it names one of
 *     the trip's dates, or one of its places — and somebody says yes.
 *   - **A reading is not a fixpoint.** The times read off a document
 *     are returned as hints next to the line they were read from. Ask
 *     for a fixpoint and you use the same organiser-only call as
 *     always (`POST …/fixpoints`); OCR misreads a 7 as a 1 often
 *     enough that a departure written by machine would be a trap.
 *   - **The trip is shared, the paperwork is not.** Attaching a
 *     document does not hand it to the other participants. Anybody on
 *     the trip who may not see the document sees that one is attached
 *     and in which role — never its title, its sender or its file.
 *   - **Anyone on the trip may attach one.** Contributing the ticket
 *     you booked is a contribution, not a change to the frame, and
 *     §6.2 holds back only the frame, the guest list and the casting
 *     vote.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import db from "../db/database";
import { documents, tripPlanDocuments, users } from "../db/schema";
import { loadUserGroupIds, visibleDocumentsWhere } from "../documents/visibility";
import { requirePermission } from "../user/auth-handler";
import {
  hardTimesIn,
  matchesTrip,
  travelRoleOf,
  type TimeHint,
  type TravelRole,
} from "./doc-hints";
import { addDays } from "./leg-dates";
import { isOnTrip } from "./plan-access";
import { loadPlan, type StoredLeg, type StoredPlan } from "./plan-store";

/** The roles a link may carry. Anything else is refused, not coerced. */
const ROLES: readonly TravelRole[] = ["lodging", "transport", "rental", "ticket"];

/**
 * How far either side of the trip a document's own date still counts as
 * "for this trip". A confirmation is written months ahead, so this is
 * not the main signal — the mentioned date or place is (`matchesTrip`).
 * It exists so a ticket bought the evening before is offered too.
 */
const WINDOW_DAYS = 3;

/** Enough to look through without reading the whole corpus into memory. */
const SCAN_LIMIT = 200;

export interface PlanDocumentsRequest {
  planId: number;
}

export interface LinkedDocument {
  /** The link's own id, so it can be removed. */
  id: number;
  documentId: number;
  role: TravelRole | string;
  note: string | null;
  /** Who attached it — "Papa hat das Ticket eingehängt" (§20.1's rule). */
  linkedBy: string | null;
  /**
   * False when the caller may not see this document. Then everything
   * below is null: the trip says a document is there, the documents
   * service decides who reads it.
   */
  readable: boolean;
  title: string | null;
  sender: string | null;
  /** The date printed on the document, when one was detected. */
  docDate: string | null;
  /** Hard times read off it — proposals for §4.4, not fixpoints. */
  hints: TimeHint[];
}

export interface PlanDocumentsResponse {
  documents: LinkedDocument[];
}

export interface DocumentSuggestion {
  documentId: number;
  title: string | null;
  sender: string | null;
  docDate: string | null;
  role: TravelRole;
  /** Why this one is being offered, in words (§8.2). */
  reasons: string[];
}

export interface DocumentSuggestionsResponse {
  suggestions: DocumentSuggestion[];
  /**
   * Null when the trip has no dates. Then only the places can match,
   * which is worth saying rather than showing a short list as if it
   * were the whole answer.
   */
  window: { from: string; to: string } | null;
}

export interface LinkDocumentRequest {
  planId: number;
  documentId: number;
  /** Defaults to what the reading makes of the document. */
  role?: string;
  note?: string;
}

export interface UnlinkDocumentRequest {
  planId: number;
  documentId: number;
}

export interface LinkDocumentResponse {
  document: LinkedDocument;
}

export interface UnlinkDocumentResponse {
  removed: boolean;
}

/** What this trip has on paper. */
export const planDocuments = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/documents", auth: true },
  async (req: PlanDocumentsRequest): Promise<PlanDocumentsResponse> => {
    const userId = requireUser();
    if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");
    return { documents: await linkedDocuments(req.planId, userId) };
  },
);

/**
 * "Ich habe eine Hotelbuchung für diesen Zeitraum gefunden — als Basis
 * nehmen?" (§8.2)
 *
 * Two signals decide, and either alone is enough: the document names
 * one of the trip's dates, or one of its places. It must always be
 * travel paperwork on top of that — a phone bill from the week of the
 * holiday names the date too, and offering it would teach people to
 * stop reading the list.
 *
 * Matched on the fields the classifier already condensed — title,
 * sender, summary, filename — not on the full OCR text. That keeps one
 * screen from dragging a corpus of full texts through memory, and those
 * fields are where a booking says what it is.
 */
export const suggestPlanDocuments = api(
  {
    expose: true,
    method: "GET",
    path: "/trip-planner/plans/:planId/documents/suggestions",
    auth: true,
  },
  async (req: PlanDocumentsRequest): Promise<DocumentSuggestionsResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    return suggestionsFor(plan, userId);
  },
);

/**
 * The suggestion list itself, so the readiness check (§8.6) can ask the
 * same question one screen earlier: are there papers that look like
 * they belong to this trip and that nobody has attached?
 */
export async function suggestionsFor(
  plan: StoredPlan,
  userId: number,
): Promise<DocumentSuggestionsResponse> {
  const dates = tripDates(plan);
  const places = tripPlaces(plan);
  const window = dates.length
    ? { from: addDays(dates[0], -WINDOW_DAYS), to: addDays(dates[dates.length - 1], WINDOW_DAYS) }
    : null;

  const linked = await db
    .select({ id: tripPlanDocuments.document_id })
    .from(tripPlanDocuments)
    .where(eq(tripPlanDocuments.plan_id, plan.id));
  const already = new Set(linked.map((row) => row.id));

  const groupIds = await loadUserGroupIds(userId);
  const scope = visibleDocumentsWhere(userId, groupIds);
  const dated = window
    ? and(gte(documents.doc_date, window.from), lte(documents.doc_date, window.to))
    : undefined;
  // Places are matched in SQL as well as in the reading, so a booking
  // written half a year ago still surfaces: its own date is nowhere
  // near the trip, but the destination is printed on it.
  const named = places.length
    ? or(...places.map((place) => sql`(
        coalesce(${documents.title}, '') || ' ' ||
        coalesce(${documents.sender}, '') || ' ' ||
        coalesce(${documents.summary}, '') || ' ' ||
        ${documents.original_filename}
      ) ILIKE ${`%${place}%`}`))
    : undefined;
  const reach = dated && named ? or(dated, named) : dated ?? named;
  if (!reach) return { suggestions: [], window };

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      sender: documents.sender,
      summary: documents.summary,
      filename: documents.original_filename,
      docDate: documents.doc_date,
    })
    .from(documents)
    .where(and(scope, reach))
    .orderBy(desc(documents.doc_date))
    .limit(SCAN_LIMIT);

  const suggestions: DocumentSuggestion[] = [];
  for (const row of rows) {
    if (already.has(row.id)) continue;
    const match = matchesTrip(
      {
        title: row.title,
        sender: row.sender,
        summary: row.summary,
        filename: row.filename,
        docDate: row.docDate,
      },
      { dates, places, window },
    );
    if (!match) continue;
    suggestions.push({
      documentId: row.id,
      title: row.title,
      sender: row.sender,
      docDate: row.docDate,
      role: match.role,
      reasons: match.reasons,
    });
  }
  return { suggestions, window };
}

/** "Ja, das gehört dazu." */
export const linkPlanDocument = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/documents", auth: true },
  async (req: LinkDocumentRequest): Promise<LinkDocumentResponse> => {
    const userId = requireUser();
    if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");

    const role = req.role?.trim();
    if (role !== undefined && role !== "" && !ROLES.includes(role as TravelRole)) {
      throw APIError.invalidArgument(`unbekannte Rolle: ${role}`);
    }

    // Only a document the caller may see: linking is otherwise a way to
    // ask "does document 4711 exist" one id at a time.
    const [doc] = await db
      .select({
        id: documents.id,
        title: documents.title,
        sender: documents.sender,
        summary: documents.summary,
        filename: documents.original_filename,
      })
      .from(documents)
      .where(and(
        eq(documents.id, req.documentId),
        visibleDocumentsWhere(userId, await loadUserGroupIds(userId)),
      ))
      .limit(1);
    if (!doc) throw APIError.notFound("document not found");

    const chosen = role && role !== ""
      ? (role as TravelRole)
      : travelRoleOf({
        title: doc.title,
        sender: doc.sender,
        summary: doc.summary,
        filename: doc.filename,
      }) ?? "ticket";

    await db
      .insert(tripPlanDocuments)
      .values({
        plan_id: req.planId,
        document_id: req.documentId,
        role: chosen,
        note: req.note?.trim() || null,
        linked_by: userId,
      })
      // Attaching the same paper twice is the same statement twice —
      // and re-attaching with a corrected role should correct it.
      .onConflictDoUpdate({
        target: [tripPlanDocuments.plan_id, tripPlanDocuments.document_id],
        set: { role: chosen, note: req.note?.trim() || null },
      });

    const all = await linkedDocuments(req.planId, userId);
    const linked = all.find((entry) => entry.documentId === req.documentId);
    if (!linked) throw APIError.internal("link was written but cannot be read back");
    return { document: linked };
  },
);

/** "Doch nicht." The document itself is untouched. */
export const unlinkPlanDocument = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/documents/remove",
    auth: true,
  },
  async (req: UnlinkDocumentRequest): Promise<UnlinkDocumentResponse> => {
    const userId = requireUser();
    if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");

    const gone = await db
      .delete(tripPlanDocuments)
      .where(and(
        eq(tripPlanDocuments.plan_id, req.planId),
        eq(tripPlanDocuments.document_id, req.documentId),
      ))
      .returning({ id: tripPlanDocuments.id });
    return { removed: gone.length > 0 };
  },
);

/**
 * The trip's documents as this caller may see them.
 *
 * Two queries rather than one join: the links belong to the trip and
 * everybody on it sees them, the document rows belong to the documents
 * service and its visibility decides. Joining them would make it far
 * too easy to leak the second through the first.
 *
 * Exported for the readiness check (§8.6), which asks the same question
 * one screen earlier.
 */
export async function linkedDocuments(
  planId: number,
  userId: number,
): Promise<LinkedDocument[]> {
  const links = await db
    .select({
      id: tripPlanDocuments.id,
      documentId: tripPlanDocuments.document_id,
      role: tripPlanDocuments.role,
      note: tripPlanDocuments.note,
      linkedBy: users.name,
    })
    .from(tripPlanDocuments)
    .leftJoin(users, eq(users.id, tripPlanDocuments.linked_by))
    .where(eq(tripPlanDocuments.plan_id, planId))
    .orderBy(asc(tripPlanDocuments.created_at));
  if (links.length === 0) return [];

  const groupIds = await loadUserGroupIds(userId);
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      sender: documents.sender,
      docDate: documents.doc_date,
      text: documents.extracted_text,
    })
    .from(documents)
    .where(and(
      inArray(documents.id, links.map((link) => link.documentId)),
      visibleDocumentsWhere(userId, groupIds),
    ));
  const readable = new Map(rows.map((row) => [row.id, row]));

  return links.map((link) => {
    const doc = readable.get(link.documentId);
    if (!doc) {
      return {
        id: link.id,
        documentId: link.documentId,
        role: link.role,
        note: link.note,
        linkedBy: link.linkedBy,
        readable: false,
        title: null,
        sender: null,
        docDate: null,
        hints: [],
      };
    }
    return {
      id: link.id,
      documentId: link.documentId,
      role: link.role,
      note: link.note,
      linkedBy: link.linkedBy,
      readable: true,
      title: doc.title,
      sender: doc.sender,
      docDate: doc.docDate,
      hints: hardTimesIn(doc.text),
    };
  });
}

/** Every date the trip covers, earliest first. */
function tripDates(plan: StoredPlan): string[] {
  const dates = new Set<string>();
  for (const leg of plan.legs) {
    if (leg.startDate === null) continue;
    const days = Math.max(leg.days.length, 1);
    for (let i = 0; i < days; i += 1) dates.add(addDays(leg.startDate, i));
  }
  return [...dates].sort();
}

/** What the trip calls its places — the hotel first, then the city. */
function tripPlaces(plan: StoredPlan): string[] {
  const places = new Set<string>();
  for (const leg of plan.legs as StoredLeg[]) {
    for (const name of [leg.anchorLabel, leg.title]) {
      const trimmed = name?.trim();
      if (trimmed) places.add(trimmed);
    }
  }
  if (plan.title?.trim()) places.add(plan.title.trim());
  return [...places];
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
