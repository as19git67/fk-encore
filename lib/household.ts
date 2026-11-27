/**
 * Who shares with whom: groups and the household (#1647).
 *
 * A household is a group marked `household`. Modules that keep things for the
 * whole house — the utility meters (meter/), the home systems (home/) — share
 * them with that group: the owner sees a row, and every member of the row's
 * group does. Changing the row itself stays with its owner and the owners of
 * its group (`group_members.role = 'owner'`).
 *
 * A user's settings scope is the household they belong to (the lowest group
 * id if they belong to several), otherwise their own personal settings.
 *
 * The helpers live here rather than in one module so that every module asks
 * the same question the same way (documentation/plans/haus-anlagen.md).
 */

import { and, asc, eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { groupMembers, groups } from "../db/schema";

export type SettingsScope =
  | { kind: "personal"; userId: number }
  | { kind: "household"; groupId: number; groupName: string };

export interface HouseholdGroup {
  id: number;
  name: string;
  myRole: "owner" | "member";
}

/** The household group the user belongs to, if any (lowest id wins). */
export async function loadHouseholdGroup(userId: number): Promise<HouseholdGroup | null> {
  const row = await dbFirst<HouseholdGroup>(
    db
      .select({ id: groups.id, name: groups.name, myRole: groupMembers.role })
      .from(groups)
      .innerJoin(
        groupMembers,
        and(eq(groupMembers.group_id, groups.id), eq(groupMembers.user_id, userId)),
      )
      .where(eq(groups.household, true))
      .orderBy(asc(groups.id))
      .limit(1),
  );
  return row ?? null;
}

/** Whose settings apply when `userId` looks at costs and reports. */
export async function resolveSettingsScope(userId: number): Promise<SettingsScope> {
  const household = await loadHouseholdGroup(userId);
  return household
    ? { kind: "household", groupId: household.id, groupName: household.name }
    : { kind: "personal", userId };
}

/** Every group id the user belongs to (visibility scope). */
export async function loadUserGroupIds(userId: number): Promise<number[]> {
  const rows = await dbAll<{ group_id: number }>(
    db
      .select({ group_id: groupMembers.group_id })
      .from(groupMembers)
      .where(eq(groupMembers.user_id, userId)),
  );
  return rows.map((r) => r.group_id);
}

/** Groups in which the user has the `owner` role — they may manage its rows. */
export async function loadOwnedGroupIds(userId: number): Promise<number[]> {
  const rows = await dbAll<{ group_id: number }>(
    db
      .select({ group_id: groupMembers.group_id })
      .from(groupMembers)
      .where(and(eq(groupMembers.user_id, userId), eq(groupMembers.role, "owner"))),
  );
  return rows.map((r) => r.group_id);
}

export interface ShareGroup {
  id: number;
  name: string;
  household: boolean;
}

/**
 * The groups the user may share a row with — every group they belong to —
 * for a module whose users need not be allowed to manage groups.
 */
export async function loadShareGroups(userId: number): Promise<ShareGroup[]> {
  return await dbAll<ShareGroup>(
    db
      .select({ id: groups.id, name: groups.name, household: groups.household })
      .from(groups)
      .innerJoin(
        groupMembers,
        and(eq(groupMembers.group_id, groups.id), eq(groupMembers.user_id, userId)),
      )
      .orderBy(asc(groups.name), asc(groups.id)),
  );
}

/**
 * May `userId` change a shared row itself — master data, sharing, deletion?
 * Its owner and the owners of its group may; other members only see it (and
 * whatever the module lets every member do).
 */
export function mayManageShared(
  userId: number,
  row: { owner_user_id: number; group_id: number | null },
  ownedGroupIds: number[],
): boolean {
  if (row.owner_user_id === userId) return true;
  return row.group_id !== null && ownedGroupIds.includes(row.group_id);
}

/**
 * The group a new or changed row is shared with. `undefined` means "no
 * choice made": the row goes to the caller's household, or stays private
 * without one. `null` keeps it private. A group id must be one the caller
 * belongs to — nobody posts into a group they are not in.
 */
export async function resolveShareGroup(
  userId: number,
  groupId: number | null | undefined,
): Promise<number | null> {
  if (groupId === undefined) return (await loadHouseholdGroup(userId))?.id ?? null;
  if (groupId === null) return null;
  const groupIds = await loadUserGroupIds(userId);
  if (!groupIds.includes(groupId)) {
    throw APIError.invalidArgument("you are not a member of this group");
  }
  return groupId;
}
