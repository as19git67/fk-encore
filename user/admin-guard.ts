/**
 * The Admin role is only touchable by administrators.
 *
 * Three permissions read like ordinary delegations and are not:
 *
 *   users.update  — may change any user's email and password, an
 *                   administrator's included. Change it, log in as them.
 *   roles.assign  — may hand the Admin role to anyone, the holder included.
 *   roles.update  — may attach any permission to any role.
 *
 * The descriptions now say so where they are granted (see db/seed.ts), but
 * a warning is not a boundary. This is the boundary: whatever those
 * permissions allow in general, doing it *to an administrator or to the
 * Admin role* additionally requires being one.
 *
 * That closes the escalation without changing what an administrator can do,
 * and without touching the ordinary case — a delegate managing ordinary
 * accounts and ordinary roles notices nothing.
 *
 * What it deliberately does not do is stop `roles.update` from stacking
 * permissions onto some *other* role the holder has. The obvious rule for
 * that — you may only grant what you hold yourself — would also stop
 * administrators granting `photos.purge` and `finance.admin`, which the
 * seed excludes from the Admin role on purpose (db/seed.ts). So
 * `roles.update` stays admin-equivalent by nature and is documented as
 * such rather than pretended safe.
 */

import { APIError } from "encore.dev/api";
import { and, eq } from "drizzle-orm";
import db from "../db/database";
import { roles, userRoles } from "../db/schema";
import { dbFirst } from "../db/adapter";

/** The role whose name carries the meaning. Same string the seed uses. */
export const ADMIN_ROLE_NAME = "Admin";

/** True when this user holds the Admin role. */
export async function isAdminUser(userId: number): Promise<boolean> {
  const row = await dbFirst<{ id: number }>(
    db
      .select({ id: userRoles.role_id })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.role_id))
      .where(and(eq(userRoles.user_id, userId), eq(roles.name, ADMIN_ROLE_NAME))),
  );
  return row !== undefined && row !== null;
}

/** True when this role id is the Admin role. */
export async function isAdminRole(roleId: number): Promise<boolean> {
  const row = await dbFirst<{ name: string }>(
    db.select({ name: roles.name }).from(roles).where(eq(roles.id, roleId)),
  );
  return row?.name === ADMIN_ROLE_NAME;
}

function deny(what: string): never {
  throw APIError.permissionDenied(
    `only an administrator may ${what}`,
  );
}

/**
 * Guard for acting on a *user*: passes unless the target holds the Admin
 * role and the caller does not.
 *
 * Self-modification is allowed regardless — an administrator changing their
 * own password is the normal case, and a non-administrator cannot be the
 * target here anyway.
 */
export async function requireAdminToTouchAdminUser(
  callerId: number,
  targetUserId: number,
  what: string,
): Promise<void> {
  if (callerId === targetUserId) return;
  if (!(await isAdminUser(targetUserId))) return;
  if (await isAdminUser(callerId)) return;
  deny(what);
}

/**
 * Guard for acting on a *role*: passes unless the role is Admin and the
 * caller is not an administrator.
 */
export async function requireAdminToTouchAdminRole(
  callerId: number,
  roleId: number,
  what: string,
): Promise<void> {
  if (!(await isAdminRole(roleId))) return;
  if (await isAdminUser(callerId)) return;
  deny(what);
}
