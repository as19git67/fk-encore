/**
 * Reading the votes back (§6.1).
 *
 * Its own module for one reason: the planner needs the tally and the
 * endpoints need the planner, and a module that imported both would be
 * a circle. The same shape `plan-store.ts` and `visit-store.ts` have —
 * the reading of one table, with no policy in it.
 */

import { and, eq } from "drizzle-orm";
import db from "../db/database";
import { tripPlanTravellers, tripPlanVotes, users } from "../db/schema";
import type { StoredPlan } from "./plan-store";
import {
  fairnessFrom,
  VOTE_WEIGHT,
  type FairnessRow,
  type Vote,
  type VoteValue,
} from "./votes";

export interface StoredVote extends Vote {
  userId: number | null;
  name: string;
}

/**
 * The leg's votes, each with the name of whoever it belongs to.
 *
 * The voter key is `user:4` or `traveller:9` — the two kinds of voice
 * §6.1 knows, kept apart so a proxy vote can never be silently merged
 * into the account that cast it.
 */
export async function votesOfLeg(legId: number): Promise<StoredVote[]> {
  const rows = await db
    .select({
      osmRef: tripPlanVotes.osm_ref,
      value: tripPlanVotes.value,
      heart: tripPlanVotes.heart,
      userId: tripPlanVotes.user_id,
      travellerId: tripPlanVotes.traveller_id,
      userName: users.name,
      travellerName: tripPlanTravellers.label,
    })
    .from(tripPlanVotes)
    .leftJoin(users, eq(users.id, tripPlanVotes.user_id))
    .leftJoin(tripPlanTravellers, eq(tripPlanTravellers.id, tripPlanVotes.traveller_id))
    .where(eq(tripPlanVotes.leg_id, legId));

  return rows.map((row) => {
    const name = row.userName ?? row.travellerName ?? "jemand";
    return {
      voter: row.userId !== null ? `user:${row.userId}` : `traveller:${row.travellerId}`,
      voterName: name,
      name,
      userId: row.userId,
      osmRef: row.osmRef,
      value: (row.value in VOTE_WEIGHT ? row.value : "meh") as VoteValue,
      heart: row.heart,
    };
  });
}

/**
 * The fairness account over the whole trip.
 *
 * Across legs rather than per leg: giving way in Lisbon is still giving
 * way when the group reaches Porto, and an account that resets at every
 * leg boundary would forget exactly the person it exists to remember.
 */
export async function fairnessOfPlan(plan: StoredPlan): Promise<FairnessRow[]> {
  const votes: Vote[] = [];
  const planned = new Set<string>();
  const offered = new Set<string>();
  for (const leg of plan.legs) {
    votes.push(...await votesOfLeg(leg.id));
    for (const day of leg.days) {
      for (const block of day.blocks) {
        for (const stop of block.stops) planned.add(stop.osmRef);
      }
    }
    for (const candidate of leg.pool) offered.add(candidate.osmRef);
  }
  return fairnessFrom(votes, planned, offered);
}
