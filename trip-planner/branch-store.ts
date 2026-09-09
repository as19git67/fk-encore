/**
 * Reading and writing the branches of a split block (§6.5).
 *
 * Its own module for the same reason `vote-store.ts` is: the planner
 * needs to read branches and the endpoints need the planner, and one
 * module importing both would be a circle. No policy in here — what a
 * branch may be is decided in `split.ts` and `splits.ts`.
 */

import { asc, eq, inArray } from "drizzle-orm";
import dbDefault from "../db/database";
import {
  tripPlanBranchMembers,
  tripPlanBranches,
  tripPlanStops,
  tripPlanTravellers,
  users,
} from "../db/schema";
import type { PlannedStop } from "./solver";
import { travelClassFor } from "./travel";

type Db = typeof dbDefault;

export interface BranchMember {
  /** "user:4" or "traveller:9" — the keys the votes already use. */
  key: string;
  name: string;
  userId: number | null;
  travellerId: number | null;
}

export interface StoredBranch {
  id: number;
  position: number;
  label: string;
  meetingLabel: string | null;
  meetingLat: number | null;
  meetingLon: number | null;
  /** Minutes past midnight — a real clock time (§4.4). */
  meetingMinutes: number;
  budgetMinutes: number;
  members: BranchMember[];
  stops: Array<PlannedStop & { rowId: number }>;
}

export interface NewBranch {
  label: string;
  meetingLabel?: string | null;
  meetingLat?: number | null;
  meetingLon?: number | null;
  meetingMinutes: number;
  budgetMinutes: number;
  members: Array<{ userId?: number; travellerId?: number }>;
  stops: readonly PlannedStop[];
}

/**
 * Replace a block's branches with these.
 *
 * The stops go with them: `trip_plan_stops.branch_id` cascades, so
 * deleting the old branches removes exactly the stops that belonged to
 * them and nothing else.
 */
export async function saveBranches(
  blockRowId: number,
  branches: readonly NewBranch[],
  db: Db = dbDefault,
): Promise<void> {
  await db.delete(tripPlanBranches).where(eq(tripPlanBranches.block_id, blockRowId));
  // Everything the block held as one group goes too: once it is split,
  // its content *is* the branches, and a leftover undivided stop would
  // be a spot the whole family visits while walking in two directions.
  await db.delete(tripPlanStops).where(eq(tripPlanStops.block_id, blockRowId));

  // Positions run on across the branches rather than restarting at
  // zero in each: the block's stop positions are unique per block, and
  // the order within a branch is kept by reading them in order.
  let position = 0;
  for (const [branchPosition, branch] of branches.entries()) {
    const [row] = await db
      .insert(tripPlanBranches)
      .values({
        block_id: blockRowId,
        position: branchPosition,
        label: branch.label,
        meeting_label: branch.meetingLabel ?? null,
        meeting_lat: branch.meetingLat ?? null,
        meeting_lon: branch.meetingLon ?? null,
        meeting_minutes: branch.meetingMinutes,
        budget_minutes: branch.budgetMinutes,
      })
      .returning({ id: tripPlanBranches.id });

    for (const member of branch.members) {
      await db.insert(tripPlanBranchMembers).values({
        branch_id: row.id,
        user_id: member.userId ?? null,
        traveller_id: member.travellerId ?? null,
      });
    }

    for (const stop of branch.stops) {
      await db.insert(tripPlanStops).values({
        block_id: blockRowId,
        branch_id: row.id,
        position: position++,
        osm_ref: stop.osmRef,
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        category: stop.category,
        dwell_minutes: stop.dwellMinutes,
        travel_minutes: stop.travelFromPrevious.minutes,
        travel_distance_m: stop.travelFromPrevious.distanceM,
        status: "planned",
        pinned: false,
        local_name: stop.localName ?? null,
        wikipedia_url: stop.wikipediaUrl ?? null,
        facade_azimuth: stop.facadeAzimuth ?? null,
        kind: stop.kind ?? null,
        origin: stop.origin ?? "search",
      });
    }
  }
}

/** Take a block's split apart again. Its stops go with the branches. */
export async function dropBranches(blockRowId: number, db: Db = dbDefault): Promise<void> {
  await db.delete(tripPlanBranches).where(eq(tripPlanBranches.block_id, blockRowId));
}

/** The branches of these blocks, by block row id. */
export async function loadBranches(
  blockRowIds: readonly number[],
  db: Db = dbDefault,
): Promise<Map<number, StoredBranch[]>> {
  const byBlock = new Map<number, StoredBranch[]>();
  if (blockRowIds.length === 0) return byBlock;

  const rows = await db
    .select()
    .from(tripPlanBranches)
    .where(inArray(tripPlanBranches.block_id, [...blockRowIds]))
    .orderBy(asc(tripPlanBranches.block_id), asc(tripPlanBranches.position));
  if (rows.length === 0) return byBlock;

  const branchIds = rows.map((row) => row.id);
  const memberRows = await db
    .select({
      branchId: tripPlanBranchMembers.branch_id,
      userId: tripPlanBranchMembers.user_id,
      travellerId: tripPlanBranchMembers.traveller_id,
      userName: users.name,
      travellerName: tripPlanTravellers.label,
    })
    .from(tripPlanBranchMembers)
    .leftJoin(users, eq(users.id, tripPlanBranchMembers.user_id))
    .leftJoin(
      tripPlanTravellers,
      eq(tripPlanTravellers.id, tripPlanBranchMembers.traveller_id),
    )
    .where(inArray(tripPlanBranchMembers.branch_id, branchIds));

  const stopRows = await db
    .select()
    .from(tripPlanStops)
    .where(inArray(tripPlanStops.branch_id, branchIds))
    .orderBy(asc(tripPlanStops.branch_id), asc(tripPlanStops.position));

  for (const row of rows) {
    const branch: StoredBranch = {
      id: row.id,
      position: row.position,
      label: row.label,
      meetingLabel: row.meeting_label,
      meetingLat: row.meeting_lat,
      meetingLon: row.meeting_lon,
      meetingMinutes: row.meeting_minutes,
      budgetMinutes: row.budget_minutes,
      members: memberRows
        .filter((member) => member.branchId === row.id)
        .map((member) => ({
          key: member.userId !== null ? `user:${member.userId}` : `traveller:${member.travellerId}`,
          name: member.userName ?? member.travellerName ?? "jemand",
          userId: member.userId,
          travellerId: member.travellerId,
        })),
      stops: stopRows
        .filter((stop) => stop.branch_id === row.id)
        .map((stop) => ({
          rowId: stop.id,
          osmRef: stop.osm_ref,
          name: stop.name,
          localName: stop.local_name,
          wikipediaUrl: stop.wikipedia_url,
          facadeAzimuth: stop.facade_azimuth,
          kind: stop.kind,
          origin: stop.origin,
          lat: stop.lat,
          lon: stop.lon,
          category: stop.category,
          dwellMinutes: stop.dwell_minutes,
          score: 0,
          travelFromPrevious: {
            minutes: stop.travel_minutes,
            distanceM: stop.travel_distance_m,
            // The mode is the leg's, and this reader does not have it;
            // the card recomputes the class when it draws the day.
            travelClass: travelClassFor(stop.travel_minutes, "foot"),
          },
        })),
    };
    const list = byBlock.get(row.block_id) ?? [];
    list.push(branch);
    byBlock.set(row.block_id, list);
  }
  return byBlock;
}
