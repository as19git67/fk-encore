/**
 * "Tag füllen" and "Alle Tage füllen" (stage 8, step 2 of
 * `reise-planen-und-unterwegs.md`). The choice is `open-fill.ts`; this
 * reads the stay, the weather and the day's clock, shows the day as it
 * would look, and writes only on "Übernehmen".
 *
 * What it writes are soft stops (`placed_by = 'fill'`): a proposal for
 * the day, which goes back to the open spots by itself if the day does
 * not reach it (`open-return.ts`). Accepting orders the day, as
 * "Reihenfolge vorschlagen" would, and is one line under "Änderungen"
 * that takes the spots off again.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripPlanOps } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { orderBlocks } from "./day-order-api";
import { withDayTimes } from "./day-times";
import { dayWalkOfStored } from "./day-walk";
import { addDays } from "./leg-dates";
import { insertStop, MoveError, recomputeDay } from "./move";
import { namesSentence } from "./open-return";
import { fitPicks, pickForDay, type FillAnchor, type FillPick, type FillSpot } from "./open-fill";
import {
  loadPlan,
  planOwner,
  removeFromPool,
  saveMovedDays,
  saveRedistribution,
  type StoredCandidate,
  type StoredDay,
  type StoredLeg,
  type StoredPlan,
} from "./plan-store";
import { dayLabel, localToday, stayWeather } from "./stay-weather-api";
import type { DayWeather } from "./stay-weather";
import { zoneAt } from "./time-zone";
import { candidateOfStop, stopOfCandidate } from "./to-pool";
import type { CurrentBlock } from "./redistribute";

/** The journal kind of an accepted fill; undone by taking its soft stops off again. */
export const FILL_DAY_OP = "fill-day";
export const FILL_DAY_UNDO_OP = "fill-day-undo";

/** One line of the day as it would look. */
export interface FillLine {
  osmRef: string;
  name: string;
  etaMinutes: number | null;
  /** Proposed by this fill; the rest already stands on the day. */
  proposed: boolean;
}

export interface FillProposal {
  dayIndex: number;
  /** "Do 3.9." or "Tag 2". */
  label: string;
  /** The open spots proposed, in the order they would be done, each with why. */
  picks: FillPick[];
  /** The whole day as it would look, firm and fixed stops included. */
  line: FillLine[];
  /** What the day has left before the fill. */
  freeMinutes: number;
  /** By how far the day would run past its window; it only does when it already did. */
  overrunMinutes: number;
}

export interface FillDayRequest {
  planId: number;
  legIndex: number;
  dayIndex: number;
  /** On the running day: the local minute of now; nothing is proposed before it. */
  fromMinutes?: number;
}

export interface FillDayResponse {
  proposal: FillProposal;
  /** The forecast could not be fetched; rain may not have been weighed. */
  degraded: boolean;
}

export const fillTripDay = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/legs/:legIndex/days/:dayIndex/fill", auth: true },
  async (req: FillDayRequest): Promise<FillDayResponse> => {
    const userId = requireUser();
    const { leg } = await stayOf(req.planId, req.legIndex, userId);
    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${req.legIndex}`);
    const now = new Date();
    const today = localToday(zoneAt(leg.anchor), now);
    if (isPast(leg, day, today)) throw APIError.failedPrecondition("dieser Tag ist schon vorbei");
    const { weather, degraded } = await stayWeather(leg, now);
    const proposal = proposeDay(leg, day, leg.pool, { weather, today, fromMinutes: validMinute(req.fromMinutes) });
    return { proposal, degraded };
  },
);

export interface FillStayRequest {
  planId: number;
  legIndex: number;
  /** For the running day, as with one day. */
  fromMinutes?: number;
}

export interface FillStayResponse {
  /** One per coming day, in order; a spot proposed for one day is not proposed again. */
  proposals: FillProposal[];
  degraded: boolean;
}

export const fillTripStay = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/legs/:legIndex/fill", auth: true },
  async (req: FillStayRequest): Promise<FillStayResponse> => {
    const userId = requireUser();
    const { leg } = await stayOf(req.planId, req.legIndex, userId);
    const now = new Date();
    const today = localToday(zoneAt(leg.anchor), now);
    const { weather, degraded } = await stayWeather(leg, now);
    const fromMinutes = validMinute(req.fromMinutes);
    let open: readonly StoredCandidate[] = leg.pool;
    const proposals: FillProposal[] = [];
    for (const day of [...leg.days].sort((a, b) => a.dayIndex - b.dayIndex)) {
      if (!day.detailed || isPast(leg, day, today)) continue;
      const running = leg.startDate !== null && addDays(leg.startDate, day.dayIndex) === today;
      const proposal = proposeDay(leg, day, open, { weather, today, fromMinutes: running ? fromMinutes : null });
      proposals.push(proposal);
      const taken = new Set(proposal.picks.map((pick) => pick.osmRef));
      open = open.filter((idea) => !taken.has(idea.osmRef));
    }
    return { proposals, degraded };
  },
);

export interface AcceptFillRequest {
  planId: number;
  legIndex: number;
  /** What to put where: the picks kept on the sheet, per day. */
  days: Array<{ dayIndex: number; osmRefs: string[] }>;
  fromMinutes?: number;
}

export interface AcceptFillResponse {
  plan: StoredPlan;
  /** What happened, in a sentence for the undo bar. */
  sentence: string;
  /** The journal entry; `POST …/ops/undo` with it takes the spots off again. */
  opId: number;
}

interface FilledDay {
  dayIndex: number;
  spots: Array<{ osmRef: string; name: string | null }>;
}

export const acceptTripFill = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/legs/:legIndex/fill/accept", auth: true },
  async (req: AcceptFillRequest): Promise<AcceptFillResponse> => {
    const userId = requireUser();
    if (!Array.isArray(req.days) || req.days.length === 0) throw APIError.invalidArgument("days must name at least one day");
    const { plan, leg } = await stayOf(req.planId, req.legIndex, userId);
    const fromMinutes = validMinute(req.fromMinutes);
    const today = localToday(zoneAt(leg.anchor), new Date());
    const ideas = new Map(leg.pool.map((idea) => [idea.osmRef, idea]));
    const used = new Set<string>();

    const writes: Array<{ day: StoredDay; blocks: CurrentBlock[] }> = [];
    const filled: FilledDay[] = [];
    for (const wanted of req.days) {
      const day = leg.days.find((d) => d.dayIndex === wanted.dayIndex);
      if (!day) throw APIError.notFound(`day ${wanted.dayIndex} not found in leg ${req.legIndex}`);
      if (isPast(leg, day, today)) throw APIError.failedPrecondition("dieser Tag ist schon vorbei");
      // Only what is still an idea of the stay, once: a spot placed
      // elsewhere since the sheet opened is a later decision and stays.
      const refs = (wanted.osmRefs ?? []).filter((ref) => ideas.has(ref) && !used.has(ref));
      if (refs.length === 0) continue;
      refs.forEach((ref) => used.add(ref));
      const running = leg.startDate !== null && addDays(leg.startDate, day.dayIndex) === today;
      const { blocks, placed } = withPicks(leg, day, refs.map((ref) => ideas.get(ref)!), running ? fromMinutes : null);
      if (placed.length === 0) continue;
      writes.push({ day, blocks });
      filled.push({ dayIndex: day.dayIndex, spots: placed.map((ref) => ({ osmRef: ref, name: ideas.get(ref)!.name })) });
    }
    if (filled.length === 0) throw APIError.failedPrecondition("diese Spots sind nicht mehr offen");

    await saveMovedDays(plan.id, writes);
    for (const day of filled) for (const spot of day.spots) await removeFromPool(leg.id, spot.osmRef);

    const sentence = fillSentence(leg, filled);
    const [op] = await db
      .insert(tripPlanOps)
      .values({
        plan_id: plan.id,
        client_op_id: `fill-${leg.id}-${crypto.randomUUID()}`,
        kind: FILL_DAY_OP,
        payload: { legIndex: leg.position, days: filled, sentence },
        actor_id: userId,
      })
      .returning({ id: tripPlanOps.id });

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while filling a day");
    return { plan: updated, sentence, opId: op.id };
  },
);

/** The day as "Tag füllen" would leave it. Nothing is written. */
export function proposeDay(
  leg: StoredLeg,
  day: StoredDay,
  open: readonly StoredCandidate[],
  ctx: { weather: ReadonlyMap<number, DayWeather>; today: string; fromMinutes: number | null },
): FillProposal {
  const date = leg.startDate ? addDays(leg.startDate, day.dayIndex) : null;
  const walk = dayWalkOfStored(leg.anchor, day);
  const here = ctx.weather.get(day.dayIndex)?.wetness ?? null;
  const coming = leg.days.filter((d) => d.dayIndex !== day.dayIndex && !isPast(leg, d, ctx.today));
  const drierDayAhead = here !== null && coming.some((d) => {
    const other = ctx.weather.get(d.dayIndex)?.wetness;
    return other !== undefined && other < here && (d.freeMinutes ?? 0) > 0;
  });

  const anchors: FillAnchor[] = day.blocks.flatMap((block) => block.stops).map((stop) => {
    const fixed = day.fixpoints.find((fix) => fix.spotRef === stop.osmRef);
    return { lat: stop.lat, lon: stop.lon, label: fixed?.label ?? stop.title ?? stop.name ?? "Spot", fixedMinutes: fixed?.startMinutes ?? null };
  });

  let freeMinutes = day.freeMinutes ?? 0;
  // The running day has only what is left of its window.
  if (ctx.fromMinutes !== null && day.window) freeMinutes = Math.min(freeMinutes, Math.max(0, day.window.endMinutes - ctx.fromMinutes));

  const spots: FillSpot[] = open.map((idea) => ({
    osmRef: idea.osmRef,
    name: idea.name ?? "Spot",
    lat: idea.lat,
    lon: idea.lon,
    dwellMinutes: idea.dwellMinutes,
    priority: idea.priority,
    openingHours: idea.openingHours ?? null,
    category: idea.category,
    kind: idea.kind ?? null,
  }));
  const picks = pickForDay({
    dayIndex: day.dayIndex,
    date,
    start: walk.start,
    end: walk.end,
    anchors,
    freeMinutes,
    wetness: here,
    drierDayAhead,
    otherDates: leg.startDate ? leg.days.filter((d) => d.dayIndex !== day.dayIndex).map((d) => addDays(leg.startDate!, d.dayIndex)) : [],
  }, spots);

  const byRef = new Map(open.map((idea) => [idea.osmRef, idea]));
  const base = orderBlocks(leg, day, day.blocks, ctx.fromMinutes).overrunMinutes;
  const kept = fitPicks(picks, (refs) =>
    withPicks(leg, day, refs.map((ref) => byRef.get(ref)!), ctx.fromMinutes).overrunMinutes - base);
  const result = withPicks(leg, day, kept.map((pick) => byRef.get(pick.osmRef)!), ctx.fromMinutes);

  const timed = withDayTimes([{ ...day, blocks: result.blocks } as StoredDay], {
    ideas: true,
    startDate: leg.startDate,
    anchor: leg.anchor,
    mode: leg.mode,
  })[0];
  const proposedRefs = new Set(result.placed);
  const line: FillLine[] = timed.blocks.flatMap((block) => block.stops).map((stop) => ({
    osmRef: stop.osmRef,
    name: stop.title ?? stop.name ?? "Spot",
    etaMinutes: stop.etaMinutes ?? null,
    proposed: proposedRefs.has(stop.osmRef),
  }));
  const pickByRef = new Map(kept.map((pick) => [pick.osmRef, pick]));
  return {
    dayIndex: day.dayIndex,
    label: dayLabel(leg, day.dayIndex),
    picks: line.filter((l) => l.proposed).map((l) => pickByRef.get(l.osmRef)!).filter(Boolean),
    line,
    freeMinutes: day.freeMinutes ?? 0,
    overrunMinutes: result.overrunMinutes,
  };
}

/** The day with these ideas on it as soft stops, ordered. */
function withPicks(
  leg: StoredLeg,
  day: StoredDay,
  ideas: readonly StoredCandidate[],
  fromMinutes: number | null,
): { blocks: CurrentBlock[]; placed: string[]; overrunMinutes: number } {
  const target = day.blocks.find((block) => block.kind === "spots") ?? day.blocks[0];
  let blocks: CurrentBlock[] = day.blocks;
  const placed: string[] = [];
  if (target) {
    const walk = dayWalkOfStored(leg.anchor, day);
    for (const idea of ideas) {
      try {
        blocks = insertStop({ blocks, stop: stopOfCandidate(idea, "fill"), toBlockId: target.id, walk, mode: leg.mode }).blocks;
        placed.push(idea.osmRef);
      } catch (err) {
        if (err instanceof MoveError) continue;
        throw err;
      }
    }
  }
  const ordered = orderBlocks(leg, day, blocks, fromMinutes);
  return { blocks: ordered.blocks, placed, overrunMinutes: ordered.overrunMinutes };
}

/** "Do 3.9. gefüllt: Beispielpark und Beispielmuseum", "3 Tage gefüllt: 7 Spots". */
export function fillSentence(leg: StoredLeg, days: readonly FilledDay[]): string {
  if (days.length === 1) {
    const names = days[0].spots.map((spot) => spot.name ?? "ein Spot");
    return `${dayLabel(leg, days[0].dayIndex)} gefüllt: ${namesSentence(names)}`;
  }
  const count = days.reduce((sum, day) => sum + day.spots.length, 0);
  return `${days.length} Tage gefüllt: ${count} Spots`;
}

/**
 * Take the soft stops of a `fill-day` entry off their days again, back
 * to the open spots. A stop made firm since (moved by hand), visited or
 * skipped is a later decision and stays.
 */
export async function takeFillBack(planId: number, payload: Record<string, unknown>): Promise<void> {
  const ownerId = await planOwner(planId);
  if (ownerId === null) return;
  const days = Array.isArray(payload.days) ? (payload.days as FilledDay[]) : [];
  for (const filled of days) {
    // Reloaded for each day: every write replaces the stay's pool.
    const plan = await loadPlan(planId, ownerId);
    const leg = plan?.legs.find((l) => l.position === payload.legIndex);
    const day = leg?.days.find((d) => d.dayIndex === filled.dayIndex);
    if (!plan || !leg || !day) continue;
    const refs = new Set(filled.spots.map((spot) => spot.osmRef));
    const leaving = day.blocks.flatMap((block) => block.stops)
      .filter((stop) => refs.has(stop.osmRef) && stop.placedBy === "fill" && stop.status === "planned");
    if (leaving.length === 0) continue;
    const ids = new Set(leaving.map((stop) => stop.rowId));
    const blocks = day.blocks.map((block) => ({
      ...block,
      stops: block.stops.filter((stop) => !ids.has(stop.rowId)).map((stop) => ({ ...stop })),
    }));
    recomputeDay(blocks, dayWalkOfStored(leg.anchor, day), leg.mode);
    const known = new Set(leg.pool.map((c) => c.osmRef));
    const pool = [...leg.pool, ...leaving.filter((stop) => !known.has(stop.osmRef)).map(candidateOfStop)];
    await saveRedistribution(plan.id, leg.id, day, blocks, pool);
  }
}

function isPast(leg: StoredLeg, day: StoredDay, today: string): boolean {
  return leg.startDate !== null && addDays(leg.startDate, day.dayIndex) < today;
}

async function stayOf(planId: number, legIndex: number, userId: number): Promise<{ plan: StoredPlan; leg: StoredLeg }> {
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.notFound("plan not found");
  const leg = plan.legs.find((l) => l.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
  if (leg.kind !== "stay") throw APIError.failedPrecondition("nur ein Aufenthalt hat Tage zum Füllen");
  return { plan, leg };
}

function validMinute(value: number | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value >= 24 * 60) {
    throw APIError.invalidArgument("fromMinutes must be a minute of the day");
  }
  return value;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
