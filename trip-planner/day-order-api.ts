/**
 * "Reihenfolge vorschlagen" and breaks on a day of ideas (ideas plan,
 * stage 4).
 *
 * The order is written, not just proposed: the travellers asked for it,
 * and what they see on the day afterwards is it, with the estimated
 * times the plan read derives from it (`day-times.ts`). Nothing leaves
 * the day; the answer says by how much it overruns and which ideas
 * would make it fit, and the travellers take those off themselves.
 *
 * What is done or skipped stays where it is at the front: the order is
 * of what is still to come.
 */

import { api, APIError, type Query } from "encore.dev/api";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripPlanDays, tripPlans } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { dayWalkOfStored } from "./day-walk";
import { lineOf, orderDay } from "./day-order";
import { frameOf, orderBreaksOf, orderStopOf, type DayBreak } from "./day-times";
import { leaveFrom } from "./extent";
import { MEAL_CATEGORIES, recomputeDay } from "./move";
import { loadPlan, saveMovedDays, type StoredDay, type StoredLeg, type StoredPlan } from "./plan-store";
import type { CurrentBlock } from "./redistribute";
import type { Coordinate } from "./travel";
import { addDays } from "./leg-dates";

export interface OrderTripDayRequest {
  planId: number;
  legIndex?: number;
  dayIndex: number;
}

export interface OrderTripDayResponse {
  plan: StoredPlan;
  /** How far the day runs past its window in the new order; zero when it fits. */
  overrunMinutes: number;
  /**
   * The ideas whose removal would make it fit, "Wenn Zeit" before
   * "Will", by OSM reference. Never "Muss", never a booked visit.
   */
  toDrop: string[];
}

export const orderTripDay = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/days/:dayIndex/order", auth: true },
  async (req: OrderTripDayRequest): Promise<OrderTripDayResponse> => {
    const userId = requireUser();
    const { plan, leg, day } = await dayOf(req.planId, req.legIndex ?? 0, req.dayIndex, userId);
    if (!day.detailed) throw APIError.failedPrecondition("dieser Tag ist noch nicht ausgeplant");

    const date = leg.startDate ? addDays(leg.startDate, day.dayIndex) : null;
    const walk = dayWalkOfStored(leg.anchor, day);
    let position: Coordinate = walk.start;
    let overrun = 0;
    const toDrop: string[] = [];
    const blocks: CurrentBlock[] = day.blocks.map((block) => {
      const start = position;
      if (block.stops.length > 0) position = leaveFrom(block.stops[block.stops.length - 1]);
      const frame = block.kind === "spots" ? frameOf(block, day.fixpoints) : null;
      if (!frame) return { ...block, stops: [...block.stops] };

      const settled = block.stops.filter((s) => s.status !== "planned");
      const pending = block.stops.filter((s) => s.status === "planned");
      // Food is never ordered into the day (stage 6): a restaurant put
      // on it by hand keeps its place in the line, the rest moves round it.
      const open = pending.filter((s) => !MEAL_CATEGORIES.has(s.category));
      const breaks = orderBreaksOf(day.breaks, block.id);
      const base = {
        start,
        startMinutes: frame.window.startMinutes,
        endMinutes: frame.window.endMinutes,
        stops: [],
        mode: leg.mode,
        date,
        blocked: frame.blocked,
      };
      // Where the line stands once what is past is past.
      const past = lineOf(base, settled.map((s) => orderStopOf(s, frame.tickets)), []);
      const from = settled.length > 0 ? leaveFrom(settled[settled.length - 1]) : start;
      const result = orderDay({
        ...base,
        start: from,
        startMinutes: past.endMinutes,
        stops: open.map((s) => orderStopOf(s, frame.tickets)),
        breaks: breaks.map((b) => ({ ...b, position: Math.max(0, b.position - settled.length) })),
      });
      overrun += result.overrunMinutes;
      toDrop.push(...result.toDrop);
      const byRef = new Map(open.map((s) => [s.osmRef, s]));
      const ordered = result.order.map((ref) => byRef.get(ref)!);
      pending.forEach((stop, index) => {
        if (MEAL_CATEGORIES.has(stop.category)) ordered.splice(Math.min(index, ordered.length), 0, stop);
      });
      return { ...block, stops: [...settled, ...ordered] };
    });

    recomputeDay(blocks, walk, leg.mode);
    await saveMovedDays(plan.id, [{ day, blocks }]);

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while ordering a day");
    return { plan: updated, overrunMinutes: overrun, toDrop };
  },
);

export interface AddTripBreakRequest {
  planId: number;
  legIndex?: number;
  dayIndex: number;
  /** "Mittag", "Kaffee" — what the break is for. */
  label: string;
  minutes: number;
  /** The spots block; the day's first one when absent. */
  blockId?: string;
  /** Where in the block's line, from zero; past the end or absent means last. */
  position?: number;
}

export interface TripBreakResponse {
  plan: StoredPlan;
}

/** More than this is not a break, it is the afternoon. */
export const MAX_BREAK_MINUTES = 240;

export const addTripBreak = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/days/:dayIndex/breaks", auth: true },
  async (req: AddTripBreakRequest): Promise<TripBreakResponse> => {
    const userId = requireUser();
    const label = req.label.trim();
    if (label.length === 0 || label.length > 60) throw APIError.invalidArgument("label must be 1 to 60 characters");
    if (!Number.isInteger(req.minutes) || req.minutes < 5 || req.minutes > MAX_BREAK_MINUTES) {
      throw APIError.invalidArgument(`minutes must be a whole number from 5 to ${MAX_BREAK_MINUTES}`);
    }
    const { plan, day } = await dayOf(req.planId, req.legIndex ?? 0, req.dayIndex, userId);
    const block = req.blockId
      ? day.blocks.find((b) => b.id === req.blockId && b.kind === "spots")
      : day.blocks.find((b) => b.kind === "spots");
    if (!block) throw APIError.notFound("dieser Tag hat keinen solchen Block für Orte");

    const existing = day.breaks ?? [];
    const length = block.stops.length + existing.filter((b) => b.blockId === block.id).length;
    const position = Math.min(Math.max(0, req.position ?? length), length);
    // A break put in front of others pushes them one on, like a stop.
    const shifted = existing.map((b) => (b.blockId === block.id && b.position >= position ? { ...b, position: b.position + 1 } : b));
    const added: DayBreak = { id: crypto.randomUUID(), label, minutes: req.minutes, blockId: block.id, position };
    await writeBreaks(plan.id, day.id, [...shifted, added]);
    return { plan: await reload(plan.id, userId) };
  },
);

export interface RemoveTripBreakRequest {
  planId: number;
  legIndex?: Query<number>;
  dayIndex: number;
  breakId: string;
}

export const removeTripBreak = api(
  { expose: true, method: "DELETE", path: "/trip-planner/plans/:planId/days/:dayIndex/breaks/:breakId", auth: true },
  async (req: RemoveTripBreakRequest): Promise<TripBreakResponse> => {
    const userId = requireUser();
    const { plan, day } = await dayOf(req.planId, req.legIndex ?? 0, req.dayIndex, userId);
    const existing = day.breaks ?? [];
    const gone = existing.find((b) => b.id === req.breakId);
    if (!gone) throw APIError.notFound("diese Pause gibt es an diesem Tag nicht");
    const rest = existing
      .filter((b) => b.id !== gone.id)
      .map((b) => (b.blockId === gone.blockId && b.position > gone.position ? { ...b, position: b.position - 1 } : b));
    await writeBreaks(plan.id, day.id, rest);
    return { plan: await reload(plan.id, userId) };
  },
);

async function writeBreaks(planId: number, dayId: number, breaks: readonly DayBreak[]): Promise<void> {
  await db.update(tripPlanDays)
    .set({ breaks: breaks.map(({ id, label, minutes, blockId, position }) => ({ id, label, minutes, blockId, position })) })
    .where(eq(tripPlanDays.id, dayId));
  await db.update(tripPlans).set({ updated_at: new Date().toISOString() }).where(eq(tripPlans.id, planId));
}

async function dayOf(
  planId: number,
  legIndex: number,
  dayIndex: number,
  userId: number,
): Promise<{ plan: StoredPlan; leg: StoredLeg; day: StoredDay }> {
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.notFound("plan not found");
  const leg = plan.legs.find((l) => l.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
  const day = leg.days.find((d) => d.dayIndex === dayIndex);
  if (!day) throw APIError.notFound(`day ${dayIndex} not found in leg ${legIndex}`);
  return { plan, leg, day };
}

async function reload(planId: number, userId: number): Promise<StoredPlan> {
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.internal("plan vanished while changing a break");
  return plan;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
