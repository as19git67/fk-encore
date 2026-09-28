// Retirement forecast — whose forecast a user works on.
//
// A forecast belongs to one user (user_id on every forecast table). Its
// owner can share it with a person or a group (finance_forecast_share).
// Whoever it is shared with and has no forecast of their own works on the
// owner's forecast instead: every endpoint first resolves the household
// and then reads and writes the owner's rows. No endpoints here, so the
// forecast and statements modules can both import it.

import { and, desc, eq, inArray, or } from "drizzle-orm";

import db from "../db/database";
import {
  financeForecastItem,
  financeForecastPerson,
  financeForecastScenario,
  financeForecastShare,
  groupMembers,
  groups,
  users,
} from "../db/schema";
import { getPermissionsForUser } from "../user/user.service";

console.log("[boot] finance/forecast-household.service.ts: all imports resolved");

export type HouseholdRole = "owner" | "edit" | "view";

export interface HouseholdAccess {
  /** Whose rows are read and written. */
  ownerId: number;
  /** Who is asking. */
  callerId: number;
  role: HouseholdRole;
  /** Owner and everyone the forecast is shared with, each with whether they administer finance. */
  members: Array<{ id: number; isAdmin: boolean }>;
}

export interface IncomingShare {
  shareId: number;
  ownerId: number;
  ownerName: string;
  level: "edit" | "view";
  /** The group the share came through, if not shared with the user directly. */
  groupName: string | null;
}

/** The user keeps a forecast of their own: any data, or a share of their own going out. */
export async function hasOwnForecast(userId: number): Promise<boolean> {
  const [person, item, scenario, share] = await Promise.all([
    db.select({ id: financeForecastPerson.id }).from(financeForecastPerson).where(eq(financeForecastPerson.user_id, userId)).limit(1),
    db.select({ id: financeForecastItem.id }).from(financeForecastItem).where(eq(financeForecastItem.user_id, userId)).limit(1),
    db.select({ id: financeForecastScenario.id }).from(financeForecastScenario).where(eq(financeForecastScenario.user_id, userId)).limit(1),
    db.select({ id: financeForecastShare.id }).from(financeForecastShare).where(eq(financeForecastShare.owner_user_id, userId)).limit(1),
  ]);
  return person.length + item.length + scenario.length + share.length > 0;
}

export async function groupIdsOf(userId: number): Promise<number[]> {
  const rows = await db.select({ id: groupMembers.group_id }).from(groupMembers).where(eq(groupMembers.user_id, userId));
  return rows.map((r) => r.id);
}

/** Forecasts shared with the user, directly first, then newest first. */
export async function incomingShares(userId: number): Promise<IncomingShare[]> {
  const groupIds = await groupIdsOf(userId);
  const target = groupIds.length
    ? or(eq(financeForecastShare.target_user_id, userId), inArray(financeForecastShare.target_group_id, groupIds))!
    : eq(financeForecastShare.target_user_id, userId);
  const rows = await db
    .select({
      shareId: financeForecastShare.id,
      ownerId: financeForecastShare.owner_user_id,
      ownerName: users.name,
      level: financeForecastShare.level,
      targetUserId: financeForecastShare.target_user_id,
      groupName: groups.name,
    })
    .from(financeForecastShare)
    .innerJoin(users, eq(users.id, financeForecastShare.owner_user_id))
    .leftJoin(groups, eq(groups.id, financeForecastShare.target_group_id))
    .where(target)
    .orderBy(desc(financeForecastShare.created_at), desc(financeForecastShare.id));
  return rows
    .filter((r) => r.ownerId !== userId) // one's own group share
    .sort((a, b) => Number(b.targetUserId != null) - Number(a.targetUserId != null))
    .map((r) => ({ shareId: r.shareId, ownerId: r.ownerId, ownerName: r.ownerName, level: r.level, groupName: r.targetUserId != null ? null : r.groupName }));
}

/** The owner and everyone the owner's forecast is shared with. */
export async function householdMemberIds(ownerId: number): Promise<number[]> {
  const shares = await db
    .select({ userId: financeForecastShare.target_user_id, groupId: financeForecastShare.target_group_id })
    .from(financeForecastShare)
    .where(eq(financeForecastShare.owner_user_id, ownerId));
  const ids = new Set<number>([ownerId]);
  for (const s of shares) if (s.userId != null) ids.add(s.userId);
  const groupIds = shares.map((s) => s.groupId).filter((g): g is number => g != null);
  if (groupIds.length) {
    const members = await db.select({ id: groupMembers.user_id }).from(groupMembers).where(inArray(groupMembers.group_id, groupIds));
    for (const m of members) ids.add(m.id);
  }
  return [...ids];
}

/**
 * Whose forecast the caller works on: their own when they keep one, else the
 * one shared with them (a direct share before a group share, the newest
 * first), else their own, still empty.
 */
export async function resolveHousehold(callerId: number, callerIsAdmin: boolean): Promise<HouseholdAccess> {
  let ownerId = callerId;
  let role: HouseholdRole = "owner";
  if (!(await hasOwnForecast(callerId))) {
    const [share] = await incomingShares(callerId);
    if (share) {
      ownerId = share.ownerId;
      role = share.level;
    }
  }
  const ids = await householdMemberIds(ownerId);
  const members = await Promise.all(
    ids.map(async (id) => ({
      id,
      isAdmin: id === callerId ? callerIsAdmin : (await getPermissionsForUser(id)).includes("finance.admin"),
    })),
  );
  return { ownerId, callerId, role, members };
}

/** Everything the user keeps of a forecast of their own, gone — before they join a shared one. */
export async function deleteOwnForecast(userId: number): Promise<void> {
  await db.transaction(async (tx) => {
    // Links and statements hang off the items and go with them.
    await tx.delete(financeForecastItem).where(eq(financeForecastItem.user_id, userId));
    await tx.delete(financeForecastScenario).where(eq(financeForecastScenario.user_id, userId));
    // Milestones hang off the persons.
    await tx.delete(financeForecastPerson).where(eq(financeForecastPerson.user_id, userId));
    await tx.delete(financeForecastShare).where(and(eq(financeForecastShare.owner_user_id, userId)));
  });
}
