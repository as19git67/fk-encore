/**
 * Separating for an afternoon (§6.5).
 *
 * Three calls: ask whether the votes pull the group apart, split a
 * block into branches, and put it back together. The mechanics are
 * §6.5's, verbatim: all branches start where the group separates and
 * end at the meeting point, the meeting point is a real fixpoint with a
 * clock time (§4.4), each branch's budget follows backwards from it,
 * and the existing solver runs once per branch. Nothing else is needed.
 *
 * Three decisions this file makes on top of that:
 *
 *   - **Suggested, decided by hand.** §6.5 asks the planner to offer a
 *     split when the votes diverge — a split is conflict resolution
 *     rather than compromise, the cheapest way to give everybody what
 *     they wanted. Who goes where is proposed from the votes and
 *     settled by a person.
 *   - **A split costs no heart wishes.** It is not somebody getting
 *     their way at another's expense; it is both getting their way.
 *   - **Anybody on the trip may open one.** §6.2 lists opening splits
 *     among the things everyone may do, and being on the spot is what
 *     matters when the group actually separates.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { requirePermission } from "../user/auth-handler";
import { dropBranches, loadBranches, saveBranches, type NewBranch } from "./branch-store";
import { isOnTrip } from "./plan-access";
import { loadPlan, saveRedistribution, type StoredLeg, type StoredPlan } from "./plan-store";
import { getTripPlan, type PlanResponse } from "./plans";
import { solveDay } from "./solver";
import { branchBudget, isViableBranch, suggestSplit, MIN_BRANCH_MINUTES } from "./split";
import { votesOfLeg } from "./vote-store";

export interface SplitSuggestionRequest {
  planId: number;
  legIndex?: number;
  dayIndex?: number;
}

export interface SplitSuggestionResponse {
  /** Null when the group agrees — which is most of the time. */
  suggestion: {
    sentence: string;
    a: { osmRef: string; name: string | null; voterNames: string[] };
    b: { osmRef: string; name: string | null; voterNames: string[] };
  } | null;
}

export interface SplitBranchInput {
  label: string;
  /** Who walks here — accounts and travellers, by id. */
  userIds?: number[];
  travellerIds?: number[];
  /** What this branch is going for. The solver fills the rest. */
  osmRefs?: string[];
}

export interface CreateSplitRequest {
  planId: number;
  legIndex?: number;
  dayIndex: number;
  /** Which block of the day separates, counted from zero. */
  blockIndex: number;
  /** When everybody is back together, in the day's own clock. */
  meetAt: string;
  meetingLabel?: string;
  meetingLat?: number;
  meetingLon?: number;
  branches: SplitBranchInput[];
}

export interface RemoveSplitRequest {
  planId: number;
  legIndex?: number;
  dayIndex: number;
  blockIndex: number;
}

/** "Spalten die Stimmen die Gruppe?" (§6.5) */
export const splitSuggestion = api(
  {
    expose: true,
    method: "GET",
    path: "/trip-planner/plans/:planId/splits/suggestion",
    auth: true,
  },
  async (req: SplitSuggestionRequest): Promise<SplitSuggestionResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = legOf(plan, req.legIndex);

    const candidates = [
      ...leg.pool.map((entry) => ({ osmRef: entry.osmRef, name: entry.name })),
      ...leg.days.flatMap((day) => day.blocks.flatMap((block) =>
        block.stops.map((stop) => ({ osmRef: stop.osmRef, name: stop.name })))),
    ];
    const suggestion = suggestSplit(
      await votesOfLeg(leg.id),
      candidates,
      leg.anchorLabel ?? leg.title,
    );

    return {
      suggestion: suggestion === null ? null : {
        sentence: suggestion.sentence,
        a: {
          osmRef: suggestion.a.osmRef,
          name: suggestion.a.name,
          voterNames: suggestion.a.voterNames,
        },
        b: {
          osmRef: suggestion.b.osmRef,
          name: suggestion.b.name,
          voterNames: suggestion.b.voterNames,
        },
      },
    };
  },
);

/** "Wir trennen uns hier und treffen uns um eins." */
export const createSplit = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/splits", auth: true },
  async (req: CreateSplitRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    // Opening a split is one of the things §6.2 leaves to everybody.
    if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = legOf(plan, req.legIndex);
    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${leg.position}`);
    const block = day.blocks[req.blockIndex];
    if (!block) throw APIError.notFound(`block ${req.blockIndex} not found on this day`);

    if (req.branches.length < 2) {
      throw APIError.invalidArgument("ein Split hat mindestens zwei Zweige");
    }
    const meetingMinutes = parseTimeOfDay(req.meetAt);
    const startMinutes = block.startMinutes;
    if (startMinutes === null) {
      throw APIError.failedPrecondition(
        "Dieser Block hat keine Uhrzeit im Plan, und ohne sie lässt sich kein Budget vom "
          + "Treffpunkt zurückrechnen.",
      );
    }
    if (meetingMinutes <= startMinutes) {
      throw APIError.invalidArgument("der Treffpunkt liegt vor dem Aufbruch");
    }

    // Nobody may be in two places at once, which is the one thing a
    // split has to get right about people.
    const seen = new Set<string>();
    for (const branch of req.branches) {
      for (const key of memberKeys(branch)) {
        if (seen.has(key)) {
          throw APIError.invalidArgument("jemand steht in zwei Zweigen");
        }
        seen.add(key);
      }
    }

    const meeting = req.meetingLat !== undefined && req.meetingLon !== undefined
      ? { lat: req.meetingLat, lon: req.meetingLon }
      : leg.anchor;

    const written: NewBranch[] = [];
    const taken = new Set<string>();
    for (const branch of req.branches) {
      const label = branch.label?.trim();
      if (!label) throw APIError.invalidArgument("jeder Zweig braucht einen Namen");

      // What this branch asked for goes in first, then the solver fills
      // what is left of the time — §6.5's "der vorhandene Solver läuft
      // einfach n-mal", with the branch's own wish at the front.
      const wanted = (branch.osmRefs ?? [])
        .map((ref) => findCandidate(leg, ref))
        .filter((c): c is NonNullable<typeof c> => c !== undefined)
        .map((c) => ({ ...c, score: c.score + 100 }));
      const rest = leg.pool.filter((c) =>
        !taken.has(c.osmRef) && !wanted.some((w) => w.osmRef === c.osmRef));

      // Counted backwards from the meeting, with the margin a fixpoint
      // always keeps (§4.4): being late for the group costs more than a
      // skipped spot. The way back is inside the budget rather than
      // subtracted from it — the solver pays it, because it is the one
      // that knows which stop the branch ends at.
      const budgetMinutes = branchBudget({ startMinutes, meetingMinutes });
      if (!isViableBranch(budgetMinutes)) {
        throw APIError.failedPrecondition(
          `Bis zum Treffpunkt bleiben ${budgetMinutes} Minuten — unter `
            + `${MIN_BRANCH_MINUTES} lohnt sich das Trennen nicht.`,
        );
      }

      const solved = solveDay({
        // The branch ends at the meeting point, so that is what the
        // solver returns to; it starts where the group separates.
        anchor: meeting,
        start: leg.anchor,
        blocks: [{
          id: `${block.id}-${written.length}`,
          label,
          kind: block.kind,
          baseBudgetMinutes: budgetMinutes,
          budgetMinutes,
        }],
        candidates: [...wanted, ...rest],
        maxWalkMinutes: maxWalkOf(plan),
        mode: leg.mode,
      });
      for (const stop of solved.blocks[0].stops) taken.add(stop.osmRef);

      written.push({
        label,
        meetingLabel: req.meetingLabel?.trim() || leg.anchorLabel,
        meetingLat: meeting.lat,
        meetingLon: meeting.lon,
        meetingMinutes,
        budgetMinutes,
        members: [
          ...(branch.userIds ?? []).map((id) => ({ userId: id })),
          ...(branch.travellerIds ?? []).map((id) => ({ travellerId: id })),
        ],
        stops: solved.blocks[0].stops,
      });
    }

    await saveBranches(block.rowId, written);
    return await getTripPlan({ planId: req.planId });
  },
);

/** "Doch zusammen." The block is planned as one again. */
export const removeSplit = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/splits/remove",
    auth: true,
  },
  async (req: RemoveSplitRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = legOf(plan, req.legIndex);
    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${leg.position}`);
    const block = day.blocks[req.blockIndex];
    if (!block) throw APIError.notFound(`block ${req.blockIndex} not found on this day`);

    const branches = (await loadBranches([block.rowId])).get(block.rowId) ?? [];
    if (branches.length === 0) {
      throw APIError.failedPrecondition("dieser Block ist nicht geteilt");
    }

    await dropBranches(block.rowId);

    // The block is empty now, so it is solved once more as a whole —
    // the same solver, the same pool, the group together again.
    const solved = solveDay({
      anchor: leg.anchor,
      blocks: [{
        id: block.id,
        label: block.label,
        kind: block.kind,
        baseBudgetMinutes: block.budgetMinutes,
        budgetMinutes: block.budgetMinutes,
      }],
      candidates: leg.pool,
      maxWalkMinutes: maxWalkOf(plan),
      mode: leg.mode,
    });
    const blocks = day.blocks.map((b) => (b.rowId === block.rowId
      ? { ...b, stops: solved.blocks[0].stops.map((stop) => ({
        ...stop,
        status: "planned" as const,
        pinned: false,
      })) }
      : b));
    const placed = new Set(solved.blocks[0].stops.map((stop) => stop.osmRef));
    await saveRedistribution(
      plan.id,
      leg.id,
      day,
      blocks,
      leg.pool.filter((c) => !placed.has(c.osmRef)),
    );

    return await getTripPlan({ planId: req.planId });
  },
);

function memberKeys(branch: SplitBranchInput): string[] {
  return [
    ...(branch.userIds ?? []).map((id) => `user:${id}`),
    ...(branch.travellerIds ?? []).map((id) => `traveller:${id}`),
  ];
}

function findCandidate(leg: StoredLeg, osmRef: string) {
  const inPool = leg.pool.find((candidate) => candidate.osmRef === osmRef);
  if (inPool) return inPool;
  for (const day of leg.days) {
    for (const block of day.blocks) {
      const stop = block.stops.find((s) => s.osmRef === osmRef);
      if (stop) {
        return {
          osmRef: stop.osmRef,
          name: stop.name,
          lat: stop.lat,
          lon: stop.lon,
          category: stop.category,
          dwellMinutes: stop.dwellMinutes,
          score: 1,
          reasons: [] as string[],
        };
      }
    }
  }
  return undefined;
}

function maxWalkOf(plan: StoredPlan): number {
  return typeof plan.constraints.maxWalkMinutes === "number"
    ? plan.constraints.maxWalkMinutes
    : 40;
}

function legOf(plan: StoredPlan, legIndex: number | undefined): StoredLeg {
  const wanted = legIndex ?? 0;
  const leg = plan.legs.find((candidate) => candidate.position === wanted);
  if (!leg) throw APIError.notFound(`leg ${wanted} not found in this plan`);
  return leg;
}

/** "13:00" → 780. Anything else is refused rather than guessed (§4.4). */
function parseTimeOfDay(value: string): number {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value?.trim() ?? "");
  if (!match) throw APIError.invalidArgument('meetAt must be a time of day like "13:00"');
  return Number(match[1]) * 60 + Number(match[2]);
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
