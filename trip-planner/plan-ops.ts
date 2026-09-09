/**
 * Buffered changes, merged rather than overwritten (§6.3).
 *
 * §6.3 calls concurrent editing the most expensive part of multi-user
 * and settles it in one sentence: **the plan is never written as a
 * whole.** The endpoints have always obeyed that — each of them changes
 * one thing — so what is added here is the part a device without a
 * connection needs:
 *
 *   - **Hand over a batch.** Operations made offline are buffered on
 *     the device and applied in the order they happened. They are
 *     applied one at a time against the trip as it is *now*, so
 *     somebody else's morning survives: two people who hid different
 *     spots end up with both hidden, which is the whole point of not
 *     writing the plan as a document.
 *   - **Say it twice safely.** A batch may arrive twice — the
 *     connection that dropped mid-request is exactly the case this is
 *     for. Every operation carries an id minted on the device, and the
 *     second arrival is reported as a duplicate rather than applied
 *     again.
 *   - **Show who changed what, and take it back.** The journal is what
 *     happened; an undo writes a new entry rather than erasing one.
 *
 * One operation is deliberately not undoable: putting a stop back into
 * the pool re-solves the day around the gap, and planning something
 * similar into roughly the same slot would be a new decision wearing
 * the word "undo". The call says so instead.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import db from "../db/database";
import { tripPlanOps, tripPlanVotes, users } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { hideTripSpot, unhideTripSpot } from "./hidden-spots";
import { castVote } from "./plan-votes";
import { isOnTrip } from "./plan-access";
import { findSpotNote, loadPlan, type StoredPlan } from "./plan-store";
import { getTripPlan, type PlanResponse } from "./plans";
import { saveTripSpotNote } from "./spot-notes";
import { returnStopToPool } from "./to-pool";
import {
  describe,
  inverseOf,
  isOpKind,
  isUndoable,
  validatePayload,
  type OpKind,
} from "./ops";

/** Enough for a fortnight of somebody's offline fiddling, and bounded. */
const MAX_BATCH = 100;

export interface ApplyOpsRequest {
  planId: number;
  ops: Array<{ clientOpId: string; kind: string; payload?: Record<string, unknown> }>;
}

export interface OpOutcome {
  clientOpId: string;
  /** applied | duplicate | failed */
  status: string;
  /** Why it failed, in the words the endpoint used. */
  message?: string;
}

export interface ApplyOpsResponse {
  results: OpOutcome[];
  /** The trip after the batch, so a device can replace its copy once. */
  plan: PlanResponse["plan"];
}

export interface JournalRequest {
  planId: number;
  limit?: number;
}

export interface JournalEntry {
  id: number;
  kind: string;
  /** What happened, in one sentence. */
  sentence: string;
  actor: string | null;
  at: string;
  /** False when there is no exact inverse — said rather than hidden. */
  undoable: boolean;
  undoneAt: string | null;
  undoneBy: string | null;
}

export interface JournalResponse {
  entries: JournalEntry[];
}

export interface UndoRequest {
  planId: number;
  opId: number;
  /** The undo is itself an operation, so it carries its own id. */
  clientOpId?: string;
}

/**
 * Apply what a device buffered while it had no connection.
 *
 * In order, one at a time, against the trip as it is now. A failing
 * operation does not abort the batch: the others are independent
 * statements about different spots, and throwing away nine good ones
 * because the tenth referred to a spot somebody else has since removed
 * would be the worst of both worlds. Each result says what happened.
 */
export const applyPlanOps = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/ops", auth: true },
  async (req: ApplyOpsRequest): Promise<ApplyOpsResponse> => {
    const userId = requireUser();
    if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");

    if (req.ops.length === 0) throw APIError.invalidArgument("ops is empty");
    if (req.ops.length > MAX_BATCH) {
      throw APIError.invalidArgument(`a batch holds at most ${MAX_BATCH} operations`);
    }

    // Validated before anything is written: a batch is applied in
    // order, and refusing the seventh entry halfway through leaves a
    // trip that is neither the old one nor the new one.
    for (const op of req.ops) {
      if (!op.clientOpId?.trim()) throw APIError.invalidArgument("clientOpId is required");
      if (!isOpKind(op.kind)) throw APIError.invalidArgument(`unknown operation: ${op.kind}`);
      const problem = validatePayload(op.kind, op.payload ?? {});
      if (problem) throw APIError.invalidArgument(`${op.kind}: ${problem}`);
    }

    const results: OpOutcome[] = [];
    for (const op of req.ops) {
      const clientOpId = op.clientOpId.trim();
      const kind = op.kind as OpKind;
      const payload = op.payload ?? {};

      const [seen] = await db
        .select({ id: tripPlanOps.id })
        .from(tripPlanOps)
        .where(and(
          eq(tripPlanOps.plan_id, req.planId),
          eq(tripPlanOps.client_op_id, clientOpId),
        ))
        .limit(1);
      if (seen) {
        results.push({ clientOpId, status: "duplicate" });
        continue;
      }

      try {
        const previous = await stateBefore(req.planId, userId, kind, payload);
        // Read before the operation runs: hiding a spot takes it out of
        // the pool, and a journal line that can only say "way:34"
        // afterwards is a log rather than a sentence.
        const before = await loadPlan(req.planId, userId);
        const name = before ? nameOfSpot(before, payload) : null;
        await perform(req.planId, kind, payload);
        await db.insert(tripPlanOps).values({
          plan_id: req.planId,
          client_op_id: clientOpId,
          kind,
          payload: name === null ? payload : { ...payload, name },
          previous,
          actor_id: userId,
        });
        results.push({ clientOpId, status: "applied" });
      } catch (err) {
        // The operation failed, so nothing is journalled: the journal
        // is what happened, and a refused change did not happen.
        results.push({
          clientOpId,
          status: "failed",
          message: err instanceof APIError ? err.message : "unbekannter Fehler",
        });
      }
    }

    const { plan } = await getTripPlan({ planId: req.planId });
    return { results, plan };
  },
);

/** Who changed what (§6.3), newest first. */
export const planJournal = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/ops", auth: true },
  async (req: JournalRequest): Promise<JournalResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const rows = await db
      .select({
        id: tripPlanOps.id,
        kind: tripPlanOps.kind,
        payload: tripPlanOps.payload,
        at: tripPlanOps.created_at,
        actor: users.name,
        undoneAt: tripPlanOps.undone_at,
        undoneById: tripPlanOps.undone_by,
      })
      .from(tripPlanOps)
      .leftJoin(users, eq(users.id, tripPlanOps.actor_id))
      .where(eq(tripPlanOps.plan_id, req.planId))
      .orderBy(desc(tripPlanOps.created_at))
      .limit(Math.min(Math.max(req.limit ?? 50, 1), 200));

    const names = await namesOf(rows
      .map((row) => row.undoneById)
      .filter((id): id is number => id !== null));

    return {
      entries: rows.map((row) => {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const kind = row.kind as OpKind;
        return {
          id: row.id,
          kind: row.kind,
          sentence: describe(kind, payload, nameOfSpot(plan, payload)),
          actor: row.actor,
          at: row.at,
          undoable: isOpKind(row.kind) && isUndoable(kind) && row.undoneAt === null,
          undoneAt: row.undoneAt,
          undoneBy: row.undoneById === null ? null : names.get(row.undoneById) ?? null,
        };
      }),
    };
  },
);

/**
 * Take one change back.
 *
 * Writes the inverse as a new operation and marks the original undone.
 * Nothing is deleted: §6.3 wants it visible who changed what, and a
 * journal that loses its mistakes is a journal about a trip that never
 * happened.
 */
export const undoPlanOp = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/ops/undo", auth: true },
  async (req: UndoRequest): Promise<JournalResponse> => {
    const userId = requireUser();
    if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");

    const [row] = await db
      .select()
      .from(tripPlanOps)
      .where(and(eq(tripPlanOps.id, req.opId), eq(tripPlanOps.plan_id, req.planId)))
      .limit(1);
    if (!row) throw APIError.notFound("diese Änderung gehört nicht zu dieser Reise");
    if (row.undone_at !== null) {
      throw APIError.failedPrecondition("diese Änderung ist schon zurückgenommen");
    }
    if (!isOpKind(row.kind) || !isUndoable(row.kind)) {
      throw APIError.failedPrecondition(
        "Diesen Schritt kann die App nicht zurücknehmen: der Tag wurde danach neu gerechnet. "
          + "Den Spot wieder einzuplanen ist eine neue Entscheidung, keine Rücknahme.",
      );
    }

    const inverse = inverseOf(
      row.kind,
      (row.payload ?? {}) as Record<string, unknown>,
      (row.previous ?? null) as Record<string, unknown> | null,
    );
    if (!inverse) throw APIError.failedPrecondition("dieser Schritt hat keine Umkehrung");

    await perform(req.planId, inverse.kind, inverse.payload);
    await db.insert(tripPlanOps).values({
      plan_id: req.planId,
      client_op_id: req.clientOpId?.trim() || `undo-${row.id}-${Date.now()}`,
      kind: inverse.kind,
      payload: inverse.payload,
      actor_id: userId,
    });
    await db
      .update(tripPlanOps)
      .set({ undone_at: sql`now()`, undone_by: userId })
      .where(eq(tripPlanOps.id, row.id));

    return await planJournal({ planId: req.planId });
  },
);

/** Run one operation through the endpoint that owns it. */
async function perform(
  planId: number,
  kind: OpKind,
  payload: Record<string, unknown>,
): Promise<void> {
  switch (kind) {
    case "hide-spot":
      await hideTripSpot({ planId, osmRef: payload.osmRef as string });
      return;
    case "unhide-spot":
      await unhideTripSpot({ planId, osmRef: payload.osmRef as string });
      return;
    case "vote":
      await castVote({
        planId,
        legIndex: payload.legIndex as number | undefined,
        osmRef: payload.osmRef as string,
        value: payload.value as string,
        heart: payload.heart === true,
        forTravellerId: payload.forTravellerId as number | undefined,
      });
      return;
    case "spot-note":
      await saveTripSpotNote({
        planId,
        legIndex: payload.legIndex as number,
        osmRef: payload.osmRef as string,
        title: payload.title as string | null | undefined,
        note: payload.note as string | null | undefined,
        url: payload.url as string | null | undefined,
        dwellMinutes: payload.dwellMinutes as number | null | undefined,
        photoStop: payload.photoStop as boolean | undefined,
      });
      return;
    case "stop-to-pool":
      await returnStopToPool({ planId, stopId: payload.stopId as number });
      return;
  }
}

/**
 * What this operation is about to replace.
 *
 * Read before the operation runs, because afterwards it is gone — and
 * without it an undo would have to guess, which is the one thing an
 * undo may not do.
 */
async function stateBefore(
  planId: number,
  userId: number,
  kind: OpKind,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (kind === "vote") {
    const plan = await loadPlan(planId, userId);
    const leg = plan?.legs.find((l) => l.position === ((payload.legIndex as number) ?? 0));
    if (!leg) return null;
    const [row] = await db
      .select({ value: tripPlanVotes.value, heart: tripPlanVotes.heart })
      .from(tripPlanVotes)
      .where(and(
        eq(tripPlanVotes.leg_id, leg.id),
        eq(tripPlanVotes.osm_ref, payload.osmRef as string),
        payload.forTravellerId === undefined
          ? eq(tripPlanVotes.user_id, userId)
          : eq(tripPlanVotes.traveller_id, payload.forTravellerId as number),
      ))
      .limit(1);
    return row ? { value: row.value, heart: row.heart } : null;
  }

  if (kind === "spot-note") {
    const plan = await loadPlan(planId, userId);
    const leg = plan?.legs.find((l) => l.position === (payload.legIndex as number));
    if (!leg) return null;
    const note = await findSpotNote(leg.id, payload.osmRef as string);
    return note ? { ...note } : null;
  }

  // Hiding and unhiding are each other's inverse without needing a
  // record, and a stop put back in the pool has no exact one at all.
  return null;
}

/** The trip's own name for a spot, when it knows one. */
function nameOfSpot(plan: StoredPlan, payload: Record<string, unknown>): string | null {
  const osmRef = payload.osmRef;
  if (typeof osmRef !== "string") return null;
  for (const leg of plan.legs) {
    const candidate = leg.pool.find((c) => c.osmRef === osmRef);
    if (candidate?.name) return candidate.name;
    for (const day of leg.days) {
      for (const block of day.blocks) {
        const stop = block.stops.find((s) => s.osmRef === osmRef);
        if (stop?.name) return stop.name;
      }
    }
  }
  return null;
}

async function namesOf(ids: readonly number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row.name]));
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
