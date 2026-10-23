/**
 * Utility meters shared with the household (#1647).
 *
 * A household is a group marked `household`. Its members see every meter
 * shared with the group, and the settings that turn readings into costs and
 * reports — tariffs and assumptions, fuel prices, heating degree days, home
 * location — belong to the household, not to the person looking. Two members
 * of the same household therefore see the same numbers.
 *
 * A user's settings scope is the household they belong to (the lowest group
 * id if they belong to several), otherwise their own personal settings.
 *
 * Permissions on a meter (documented in documentation/utility-meters.md):
 * everybody who sees a meter may read it, enter and correct readings and work
 * through anomalies; changing or deleting the meter, swapping or editing
 * devices and managing API keys stays with the meter's owner and the owners of
 * its group (`group_members.role = 'owner'`).
 */

import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import {
  groupMembers,
  groups,
  meterElectricityTariffs,
  meterHomeLocations,
  meters,
} from "../db/schema";

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

/** WHERE fragment for the tariff rows of a scope. */
export function tariffScopeWhere(scope: SettingsScope): SQL {
  return scope.kind === "household"
    ? eq(meterElectricityTariffs.group_id, scope.groupId)
    : and(
        eq(meterElectricityTariffs.owner_user_id, scope.userId),
        isNull(meterElectricityTariffs.group_id),
      )!;
}

/** WHERE fragment for the home location row of a scope. */
export function homeScopeWhere(scope: SettingsScope): SQL {
  return scope.kind === "household"
    ? eq(meterHomeLocations.group_id, scope.groupId)
    : eq(meterHomeLocations.user_id, scope.userId);
}

/** Stable key of a scope, for de-duplicating the jobs that run per scope. */
export function scopeKey(scope: SettingsScope): string {
  return scope.kind === "household" ? `g:${scope.groupId}` : `u:${scope.userId}`;
}

/**
 * One user per settings scope out of `userIds`. The daily jobs act as a user
 * (visible meters, tariffs); without this a household of three would fetch
 * the same degree days three times.
 */
export async function oneUserPerScope(userIds: number[]): Promise<number[]> {
  const seen = new Set<string>();
  const result: number[] = [];
  for (const userId of [...new Set(userIds)].sort((a, b) => a - b)) {
    const key = scopeKey(await resolveSettingsScope(userId));
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(userId);
  }
  return result;
}

/** Members of a group, lowest user id first. */
export async function groupMemberIds(groupId: number): Promise<number[]> {
  const rows = await dbAll<{ user_id: number }>(
    db
      .select({ user_id: groupMembers.user_id })
      .from(groupMembers)
      .where(eq(groupMembers.group_id, groupId))
      .orderBy(asc(groupMembers.user_id)),
  );
  return rows.map((row) => row.user_id);
}

/**
 * A user whose settings scope is exactly `row`'s — the personal owner, or a
 * member of the household whose household it is. Null when nobody resolves to
 * it any more (the group is no longer a household, the person joined one).
 */
export async function actingUserForScope(row: {
  user_id: number | null;
  group_id: number | null;
}): Promise<number | null> {
  if (row.user_id !== null) {
    const scope = await resolveSettingsScope(row.user_id);
    return scope.kind === "personal" ? row.user_id : null;
  }
  if (row.group_id === null) return null;
  for (const userId of await groupMemberIds(row.group_id)) {
    const scope = await resolveSettingsScope(userId);
    if (scope.kind === "household" && scope.groupId === row.group_id) return userId;
  }
  return null;
}

// ── Household setting ───────────────────────────────────────────────────────

export interface HouseholdCandidate {
  id: number;
  name: string;
  myRole: "owner" | "member";
  household: boolean;
}

export interface HouseholdState {
  /** The household whose meters and settings the caller shares, if any. */
  household: HouseholdGroup | null;
  /** The caller's groups; an owner may mark one of them as household. */
  groups: HouseholdCandidate[];
  /** The caller's own meters that are still private. */
  privateMeterCount: number;
}

export async function getHouseholdState(userId: number): Promise<HouseholdState> {
  const household = await loadHouseholdGroup(userId);
  const candidates = await dbAll<HouseholdCandidate>(
    db
      .select({
        id: groups.id,
        name: groups.name,
        myRole: groupMembers.role,
        household: groups.household,
      })
      .from(groups)
      .innerJoin(
        groupMembers,
        and(eq(groupMembers.group_id, groups.id), eq(groupMembers.user_id, userId)),
      )
      .orderBy(asc(groups.name), asc(groups.id)),
  );
  const [privateCount] = await dbAll<{ count: number }>(
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(meters)
      .where(and(eq(meters.owner_user_id, userId), isNull(meters.group_id))),
  );
  return {
    household,
    groups: candidates,
    privateMeterCount: Number(privateCount?.count ?? 0),
  };
}

async function loadOwnRole(
  userId: number,
  groupId: number,
): Promise<"owner" | "member" | null> {
  const row = await dbFirst<{ role: "owner" | "member" }>(
    db
      .select({ role: groupMembers.role })
      .from(groupMembers)
      .where(and(eq(groupMembers.group_id, groupId), eq(groupMembers.user_id, userId))),
  );
  return row?.role ?? null;
}

/**
 * Bring the caller's personal settings into a household that has none yet,
 * so marking a household does not make the costs disappear. Copies, does not
 * move: if the group stops being a household, the personal rows are still
 * there.
 */
async function adoptPersonalSettings(userId: number, groupId: number): Promise<void> {
  const [tariffCount] = await dbAll<{ count: number }>(
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(meterElectricityTariffs)
      .where(eq(meterElectricityTariffs.group_id, groupId)),
  );
  if (Number(tariffCount?.count ?? 0) === 0) {
    await db.execute(sql`
      INSERT INTO meter_electricity_tariffs
        (owner_user_id, group_id, kind, valid_from, amount, unit, tax_status, name,
         capacity_limit_kw, source)
      SELECT owner_user_id, ${groupId}, kind, valid_from, amount, unit, tax_status, name,
             capacity_limit_kw, source
      FROM meter_electricity_tariffs
      WHERE owner_user_id = ${userId} AND group_id IS NULL
    `);
  }

  const groupHome = await dbFirst<{ id: number }>(
    db
      .select({ id: meterHomeLocations.id })
      .from(meterHomeLocations)
      .where(eq(meterHomeLocations.group_id, groupId)),
  );
  if (!groupHome) {
    const own = await dbFirst<typeof meterHomeLocations.$inferSelect>(
      db.select().from(meterHomeLocations).where(eq(meterHomeLocations.user_id, userId)),
    );
    if (own) {
      await db.insert(meterHomeLocations).values({
        group_id: groupId,
        label: own.label,
        lat: own.lat,
        lon: own.lon,
        source: own.source,
      });
    }
  }
}

/**
 * Mark `groupId` as the caller's household, or with `null` stop sharing
 * through the current one. Only an owner of the group may change it; other
 * household groups the caller owns are unmarked so the choice is unambiguous.
 */
export async function setHousehold(userId: number, groupId: number | null): Promise<HouseholdState> {
  if (groupId === null) {
    const current = await loadHouseholdGroup(userId);
    if (!current) return await getHouseholdState(userId);
    if (current.myRole !== "owner") {
      throw APIError.permissionDenied("only an owner of the group can change the household");
    }
    await dbExec(db.update(groups).set({ household: false }).where(eq(groups.id, current.id)));
    return await getHouseholdState(userId);
  }

  const role = await loadOwnRole(userId, groupId);
  if (role === null) throw APIError.notFound("group not found");
  if (role !== "owner") {
    throw APIError.permissionDenied("only an owner of the group can mark it as household");
  }

  const owned = await dbAll<{ group_id: number }>(
    db
      .select({ group_id: groupMembers.group_id })
      .from(groupMembers)
      .where(and(eq(groupMembers.user_id, userId), eq(groupMembers.role, "owner"))),
  );
  const others = owned.map((row) => row.group_id).filter((id) => id !== groupId);
  if (others.length > 0) {
    await dbExec(
      db
        .update(groups)
        .set({ household: false })
        .where(and(inArray(groups.id, others), eq(groups.household, true))),
    );
  }
  await dbExec(db.update(groups).set({ household: true }).where(eq(groups.id, groupId)));
  await adoptPersonalSettings(userId, groupId);
  return await getHouseholdState(userId);
}

/** Share every private meter of the caller with their household. */
export async function shareMetersWithHousehold(userId: number): Promise<{ shared: number }> {
  const household = await loadHouseholdGroup(userId);
  if (!household) throw APIError.failedPrecondition("no household group set");
  const result = await dbExec(
    db
      .update(meters)
      .set({ group_id: household.id, updated_at: new Date().toISOString() })
      .where(and(eq(meters.owner_user_id, userId), isNull(meters.group_id))),
  );
  return { shared: result.changes };
}
