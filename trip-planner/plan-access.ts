/**
 * Who may see and change a trip (§6.2).
 *
 * A plan used to be strictly the property of whoever created it: every
 * query filtered on `owner_id`, which meant a shared holiday could only
 * be planned by one person while everyone else watched. §6.2 wants the
 * opposite — "alles andere darf jeder: Spots beitragen, bewerten,
 * Alternativen vorschlagen, Splits eröffnen, unterwegs umplanen" — with
 * exactly three rights held back.
 *
 * So there are two questions, and keeping them apart is the whole point
 * of this module:
 *
 *   - **May I touch this trip at all?** The owner and everyone invited.
 *     Nearly everything asks this one.
 *   - **Am I the organiser?** The owner alone, for the three rights
 *     §6.2 reserves: changing the frame, inviting and removing people,
 *     and the casting vote.
 *
 * They are functions rather than a flag on the loaded plan because the
 * answer decides whether a query runs at all, and a check that happens
 * after the data is in hand is a check somebody will forget to make.
 *
 * **The organiser is not a share row.** They are the plan's owner,
 * which is recorded on the plan itself and cannot be lost by deleting a
 * share — a trip whose organiser was removed by a mis-click would have
 * nobody able to invite them back.
 */

import { and, eq, inArray, or } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import dbDefault from "../db/database";
import { tripPlanShares, tripPlans } from "../db/schema";

type Db = typeof dbDefault;

/**
 * A condition for `where` that admits the owner and every participant.
 *
 * Written as SQL rather than as a second round trip so it cannot be
 * left off: a query that forgets to `and()` this in fails to compile
 * against nothing, but one that filters on `owner_id` alone silently
 * hides a shared trip, and one that filters on nothing silently shows
 * everybody's.
 */
export function visibleToUser(userId: number) {
  return or(
    eq(tripPlans.owner_id, userId),
    inArray(
      tripPlans.id,
      dbDefault
        .select({ id: tripPlanShares.plan_id })
        .from(tripPlanShares)
        .where(eq(tripPlanShares.user_id, userId)),
    ),
  );
}

/** Is this person on the trip at all — as organiser or participant? */
export async function isOnTrip(
  planId: number,
  userId: number,
  db: Db = dbDefault,
): Promise<boolean> {
  const [row] = await db
    .select({ id: tripPlans.id })
    .from(tripPlans)
    .where(and(eq(tripPlans.id, planId), visibleToUser(userId)))
    .limit(1);
  return row !== undefined;
}

/** Is this person the organiser — the plan's owner (§6.2)? */
export async function isOrganiser(
  planId: number,
  userId: number,
  db: Db = dbDefault,
): Promise<boolean> {
  const [row] = await db
    .select({ id: tripPlans.id })
    .from(tripPlans)
    .where(and(eq(tripPlans.id, planId), eq(tripPlans.owner_id, userId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Guard one of the organiser's three rights (§6.2).
 *
 * The message says what the role is *for*, because "permission denied"
 * on a family holiday reads as a bug. A participant who wanted to
 * change the pace should learn that somebody can do it, not that the
 * app is broken.
 */
export async function requireOrganiser(
  planId: number,
  userId: number,
  what: string,
  db: Db = dbDefault,
): Promise<void> {
  if (await isOrganiser(planId, userId, db)) return;
  if (await isOnTrip(planId, userId, db)) {
    throw APIError.permissionDenied(
      `${what} kann nur die Person ändern, die die Reise angelegt hat. `
        + "Alles andere — Spots beitragen, umplanen unterwegs — darf jeder.",
    );
  }
  // Not on the trip at all: say the same thing an unknown id would say,
  // rather than confirming that this plan exists.
  throw APIError.notFound("plan not found");
}
