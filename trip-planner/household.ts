/**
 * The household, as a list to pick from (§6.2, §20.1).
 *
 * Inviting somebody onto a trip or into the idea collection asked for
 * an e-mail address. The album share never did: it lists the accounts
 * of this instance and lets you tap one, because everybody who can be
 * invited already has an account here — a self-hosted household is
 * small and known. This is the same list for the planner, minus the
 * people already in, and minus the AI system user, which is a row in
 * `users` for attributing curation votes and never a person to invite.
 */

import { api, APIError, type Query } from "encore.dev/api";
import { asc, eq, ne } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { ideaPoolShares, tripPlanShares, tripPlans, users } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { isOnTrip } from "./plan-access";

/** The same address `photo.service.ts` and the seed use for the AI user. */
const AI_USER_EMAIL = "ai@system.local";

export interface HouseholdUser {
  id: number;
  name: string | null;
  email: string;
}

export interface ShareableUsersRequest {
  /** Leave out who is already on this trip. */
  planId?: Query<number>;
  /** Leave out who already writes into the caller's idea collection. */
  forIdeas?: Query<boolean>;
}

export interface ShareableUsersResponse {
  users: HouseholdUser[];
}

export const listShareableUsers = api(
  { expose: true, method: "GET", path: "/trip-planner/shareable-users", auth: true },
  async (req: ShareableUsersRequest): Promise<ShareableUsersResponse> => {
    const userId = requireUser();
    const excluded = new Set<number>([userId]);

    if (req.planId !== undefined) {
      const planId = Number(req.planId);
      if (!(await isOnTrip(planId, userId))) throw APIError.notFound("plan not found");
      const [plan] = await db
        .select({ ownerId: tripPlans.owner_id })
        .from(tripPlans)
        .where(eq(tripPlans.id, planId))
        .limit(1);
      if (plan) excluded.add(plan.ownerId);
      const shared = await db
        .select({ userId: tripPlanShares.user_id })
        .from(tripPlanShares)
        .where(eq(tripPlanShares.plan_id, planId));
      for (const row of shared) excluded.add(row.userId);
    }

    if (req.forIdeas) {
      const members = await db
        .select({ userId: ideaPoolShares.user_id })
        .from(ideaPoolShares)
        .where(eq(ideaPoolShares.owner_id, userId));
      for (const row of members) excluded.add(row.userId);
    }

    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(ne(users.email, AI_USER_EMAIL))
      .orderBy(asc(users.name));

    return { users: rows.filter((row) => !excluded.has(row.id)) };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
