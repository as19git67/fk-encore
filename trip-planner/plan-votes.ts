/**
 * Everybody rates, nobody is averaged away (§6.1).
 *
 * Four calls: cast a vote, read the ballot, read the fairness account,
 * and plan the trip against what came out. The interesting decisions
 * are not in the endpoints but in what they refuse to do:
 *
 *   - **Voting does not re-plan.** People swipe through thirty spots in
 *     a minute, and re-planning after each one would be thirty
 *     different trips, twenty-nine of which nobody saw. The votes are
 *     kept and take effect the next time the trip is planned — which
 *     `POST …/votes/apply` does on request, and every other re-plan
 *     does anyway.
 *   - **Anyone on the trip may vote.** §6.2 reserves three rights to
 *     the organiser and rating is not one of them.
 *   - **A proxy voice is somebody's, not the holder's.** A small child's
 *     vote is cast by a grown-up and counted as the child's, and who
 *     cast it stays recorded — a vote whose owner is unclear is worse
 *     than no vote.
 *   - **The quota is per leg and it is checked here**, because "zwei je
 *     drei Tage" needs to know how long the leg is; the pure module
 *     only knows the arithmetic.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import db from "../db/database";
import { tripPlanShares, tripPlanTravellers, tripPlanVotes, users } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { isOnTrip } from "./plan-access";
import { spotLabel } from "./spot-label";
import { loadPlan, type StoredLeg, type StoredPlan } from "./plan-store";
import { replanAfterFrameChange, type PlanResponse } from "./plans";
import { fairnessOfPlan, votesOfLeg, type StoredVote } from "./vote-store";
import {
  fairnessSentence,
  heartQuota,
  type VoteValue,
} from "./votes";

const VALUES: readonly VoteValue[] = ["want", "meh", "rather-not"];

export interface BallotRequest {
  planId: number;
  legIndex?: number;
}

export interface BallotEntry {
  osmRef: string;
  name: string | null;
  /**
   * What to put on the row. The name where the map has one, otherwise
   * what it does know ("Kirche (ohne Namen)") — never the reference,
   * which nobody can vote on (§15.3).
   */
  label: string;
  category: string;
  /** What the caller said, or null while they have not (§6.1). */
  myVote: VoteValue | null;
  myHeart: boolean;
  /** Everybody's answers, so a ranking can be argued with (§3.8). */
  wants: string[];
  ratherNots: string[];
  hearts: string[];
  /** True when this spot is on a day rather than waiting in the pool. */
  planned: boolean;
}

export interface BallotResponse {
  legIndex: number;
  entries: BallotEntry[];
  /** Settings left for the caller on this leg (§6.1). */
  heartsLeft: number;
  heartQuota: number;
  /** Who has not said anything at all yet. */
  silent: string[];
}

export interface FairnessResponse {
  rows: Array<{ voter: string; name: string; granted: number; deferred: number }>;
  /** The account in one sentence, or null when there is nothing to say. */
  sentence: string | null;
}

export interface CastVoteRequest {
  planId: number;
  legIndex?: number;
  osmRef: string;
  value: string;
  /** Spend one of this leg's settings on it (§6.1). */
  heart?: boolean;
  /** Cast for somebody without an account — a child's voice (§6.1). */
  forTravellerId?: number;
}

export interface CastVoteResponse {
  osmRef: string;
  value: VoteValue;
  heart: boolean;
  heartsLeft: number;
}

/** What is up for a vote on this leg, and what everybody said. */
export const tripBallot = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/votes", auth: true },
  async (req: BallotRequest): Promise<BallotResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = legOf(plan, req.legIndex);

    const votes = await votesOfLeg(leg.id);
    const mine = new Map(votes
      .filter((vote) => vote.userId === userId)
      .map((vote) => [vote.osmRef, vote]));

    const planned = new Set(
      leg.days.flatMap((day) => day.blocks.flatMap((block) => block.stops.map((s) => s.osmRef))),
    );
    const entries: BallotEntry[] = [];
    const seen = new Set<string>();
    const add = (
      osmRef: string,
      name: string | null,
      category: string,
      isPlanned: boolean,
      kind?: string | null,
    ) => {
      if (seen.has(osmRef)) return;
      seen.add(osmRef);
      const on = votes.filter((vote) => vote.osmRef === osmRef);
      entries.push({
        osmRef,
        name,
        label: spotLabel({ osmRef, name, category, kind }),
        category,
        myVote: mine.get(osmRef)?.value ?? null,
        myHeart: mine.get(osmRef)?.heart ?? false,
        wants: on.filter((v) => v.value === "want" && !v.heart).map((v) => v.name),
        ratherNots: on.filter((v) => v.value === "rather-not").map((v) => v.name),
        hearts: on.filter((v) => v.heart).map((v) => v.name),
        planned: isPlanned,
      });
    };
    // The planned days first: those are the spots a vote would change
    // something about right now.
    for (const day of leg.days) {
      for (const block of day.blocks) {
        for (const stop of block.stops) {
          add(stop.osmRef, stop.name, stop.category, true, stop.kind);
        }
      }
    }
    for (const candidate of leg.pool) {
      add(candidate.osmRef, candidate.name, candidate.category, false, candidate.kind);
    }

    const quota = heartQuota(leg.days.length);
    const spent = votes.filter((vote) => vote.userId === userId && vote.heart).length;

    return {
      legIndex: leg.position,
      entries,
      heartsLeft: Math.max(0, quota - spent),
      heartQuota: quota,
      silent: await silentVoices(plan, votes),
    };
  },
);

/** Who has had their way, and who gave it (§6.1). */
export const tripFairness = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/fairness", auth: true },
  async (req: BallotRequest): Promise<FairnessResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const rows = await fairnessOfPlan(plan);
    return {
      rows: rows.map((row) => ({
        voter: row.voter,
        name: row.voterName ?? "jemand",
        granted: row.granted,
        deferred: row.deferred,
      })),
      sentence: fairnessSentence(rows),
    };
  },
);

/** "Will ich", "egal", "lieber nicht" — and the occasional setting. */
export const castVote = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/votes", auth: true },
  async (req: CastVoteRequest): Promise<CastVoteResponse> => {
    const userId = requireUser();
    // Rating is not one of the organiser's three rights (§6.2).
    if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = legOf(plan, req.legIndex);

    const value = req.value as VoteValue;
    if (!VALUES.includes(value)) {
      throw APIError.invalidArgument(`value must be one of ${VALUES.join(", ")}`);
    }
    const osmRef = req.osmRef.trim();
    if (!osmRef) throw APIError.invalidArgument("osmRef is required");
    if (!knowsSpot(leg, osmRef)) {
      throw APIError.notFound("dieser Spot steht bei dieser Etappe nicht zur Wahl");
    }

    // A proxy voice belongs to a traveller on *this* trip; anything
    // else would let one trip's ids vote in another's.
    let travellerId: number | null = null;
    if (req.forTravellerId !== undefined) {
      const [traveller] = await db
        .select({ id: tripPlanTravellers.id })
        .from(tripPlanTravellers)
        .where(and(
          eq(tripPlanTravellers.id, req.forTravellerId),
          eq(tripPlanTravellers.plan_id, req.planId),
        ))
        .limit(1);
      if (!traveller) throw APIError.notFound("diese Person fährt bei dieser Reise nicht mit");
      travellerId = traveller.id;
    }

    const heart = req.heart === true;
    const quota = heartQuota(leg.days.length);
    if (heart) {
      const spent = await heartsSpent(leg.id, userId, travellerId, osmRef);
      if (spent >= quota) {
        throw APIError.failedPrecondition(
          `Für diese Etappe sind ${quota} Herzenswünsche vorgesehen, und die sind vergeben. `
            + "Einen davon zurücknehmen macht wieder einen frei.",
        );
      }
    }

    const where = travellerId === null
      ? and(
        eq(tripPlanVotes.leg_id, leg.id),
        eq(tripPlanVotes.osm_ref, osmRef),
        eq(tripPlanVotes.user_id, userId),
      )
      : and(
        eq(tripPlanVotes.leg_id, leg.id),
        eq(tripPlanVotes.osm_ref, osmRef),
        eq(tripPlanVotes.traveller_id, travellerId),
      );
    const [existing] = await db
      .select({ id: tripPlanVotes.id })
      .from(tripPlanVotes)
      .where(where)
      .limit(1);

    if (existing) {
      // Voting again changes the answer rather than adding a second one.
      await db
        .update(tripPlanVotes)
        .set({ value, heart, cast_by: userId, updated_at: sql`now()` })
        .where(eq(tripPlanVotes.id, existing.id));
    } else {
      await db.insert(tripPlanVotes).values({
        leg_id: leg.id,
        osm_ref: osmRef,
        user_id: travellerId === null ? userId : null,
        traveller_id: travellerId,
        value,
        heart,
        cast_by: userId,
      });
    }

    const spentNow = await heartsSpent(leg.id, userId, travellerId, null);
    return { osmRef, value, heart, heartsLeft: Math.max(0, quota - spentNow) };
  },
);

/**
 * "So, jetzt plan das mal mit dem, was wir gesagt haben."
 *
 * Separate from casting a vote on purpose (see the file header): the
 * swiping and the planning are two different moments, and a plan that
 * rearranged itself under somebody's thumb would be unusable.
 */
export const applyVotesToPlan = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/votes/apply", auth: true },
  async (req: { planId: number }): Promise<PlanResponse> => {
    const userId = requireUser();
    if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    return await replanAfterFrameChange(plan, userId);
  },
);

/**
 * Everybody who could speak on this leg and has not.
 *
 * Both kinds of voice: the accounts the trip is shared with, and the
 * travellers whose voice somebody holds. A trip planned past a silent
 * participant is exactly what §8.6's fourth question is about.
 */
async function silentVoices(
  plan: StoredPlan,
  votes: readonly StoredVote[],
): Promise<string[]> {
  const spoke = new Set(votes.map((vote) => vote.voter));
  const silent: string[] = [];

  const participants = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, await participantIds(plan)));
  for (const person of participants) {
    if (!spoke.has(`user:${person.id}`)) silent.push(person.name);
  }

  const travellers = await db
    .select({ id: tripPlanTravellers.id, label: tripPlanTravellers.label })
    .from(tripPlanTravellers)
    .where(eq(tripPlanTravellers.plan_id, plan.id));
  for (const traveller of travellers) {
    if (!spoke.has(`traveller:${traveller.id}`)) silent.push(traveller.label);
  }
  return silent;
}

async function participantIds(plan: StoredPlan): Promise<number[]> {
  const rows = await db
    .select({ id: tripPlanShares.user_id })
    .from(tripPlanShares)
    .where(eq(tripPlanShares.plan_id, plan.id));
  return [plan.ownerId, ...rows.map((row) => row.id)];
}

/** How many settings this voice has spent on the leg, `except` aside. */
async function heartsSpent(
  legId: number,
  userId: number,
  travellerId: number | null,
  except: string | null,
): Promise<number> {
  const rows = await db
    .select({ osmRef: tripPlanVotes.osm_ref })
    .from(tripPlanVotes)
    .where(and(
      eq(tripPlanVotes.leg_id, legId),
      eq(tripPlanVotes.heart, true),
      travellerId === null
        ? and(eq(tripPlanVotes.user_id, userId), isNull(tripPlanVotes.traveller_id))
        : eq(tripPlanVotes.traveller_id, travellerId),
    ));
  return rows.filter((row) => row.osmRef !== except).length;
}

/** Is this spot on the leg at all — planned or still in the pool? */
function knowsSpot(leg: StoredLeg, osmRef: string): boolean {
  if (leg.pool.some((candidate) => candidate.osmRef === osmRef)) return true;
  return leg.days.some((day) => day.blocks.some((block) =>
    block.stops.some((stop) => stop.osmRef === osmRef)));
}

function legOf(plan: StoredPlan, legIndex: number | undefined): StoredLeg {
  const wanted = legIndex ?? 0;
  const leg = plan.legs.find((candidate) => candidate.position === wanted);
  if (!leg) throw APIError.notFound(`leg ${wanted} not found in this plan`);
  return leg;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
