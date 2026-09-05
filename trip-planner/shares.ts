/**
 * Who else is on the trip (§6.2).
 *
 * Planning a family holiday alone while everybody watches is not what
 * §6.2 describes. It gives the organiser exactly three rights — change
 * the frame, invite and remove people, the casting vote — and says of
 * everything else: *"alles andere darf jeder"*. So sharing is not a
 * permission grid; it is one list of people, and one person on it who
 * can also change the shape of the trip.
 *
 * **Organiser as organiser, not as boss.** The concept is explicit that
 * a strong leadership role would be socially wrong — a holiday is not a
 * hierarchy — and that on the road there is no leader at all: whoever
 * is there may re-plan, because a delay is a fact rather than a
 * decision. Nothing here gates anything a traveller does while
 * travelling.
 */

import { api, APIError } from "encore.dev/api";
import { and, eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { tripPlanShares, tripPlans, users } from "../db/schema";
import { isOnTrip, requireOrganiser } from "./plan-access";

export interface TripParticipant {
  userId: number;
  name: string | null;
  email: string;
  /** organiser | participant. Exactly one organiser, always. */
  role: string;
}

export interface ListParticipantsRequest {
  planId: number;
}

export interface ListParticipantsResponse {
  participants: TripParticipant[];
  /** True when the caller may invite and remove. */
  youOrganise: boolean;
}

export const listTripParticipants = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/participants", auth: true },
  async (req: ListParticipantsRequest): Promise<ListParticipantsResponse> => {
    const userId = requireUser();
    if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");

    const [plan] = await db
      .select({ ownerId: tripPlans.owner_id })
      .from(tripPlans)
      .where(eq(tripPlans.id, req.planId))
      .limit(1);
    if (!plan) throw APIError.notFound("plan not found");

    const owner = await findUser(plan.ownerId);
    const shared = await db
      .select({
        userId: tripPlanShares.user_id,
        role: tripPlanShares.role,
        name: users.name,
        email: users.email,
      })
      .from(tripPlanShares)
      .innerJoin(users, eq(users.id, tripPlanShares.user_id))
      .where(eq(tripPlanShares.plan_id, req.planId));

    return {
      // The organiser first, and labelled — a list where the person who
      // can invite is indistinguishable from everyone else answers the
      // wrong question.
      participants: [
        {
          userId: plan.ownerId,
          name: owner?.name ?? null,
          email: owner?.email ?? "",
          role: "organiser",
        },
        ...shared.map((s) => ({
          userId: s.userId,
          name: s.name,
          email: s.email,
          role: s.role,
        })),
      ],
      youOrganise: plan.ownerId === userId,
    };
  },
);

export interface InviteRequest {
  planId: number;
  /**
   * Who to invite, by the address they log in with. A name would be
   * ambiguous in a household with two Antons; an id is not something
   * anybody knows by heart.
   */
  email: string;
}

export interface InviteResponse {
  participant: TripParticipant;
  /** False when they were already on the trip. Inviting twice is not an error. */
  added: boolean;
}

export const inviteToTrip = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/participants", auth: true },
  async (req: InviteRequest): Promise<InviteResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Wer mitplant");

    const email = typeof req.email === "string" ? req.email.trim().toLowerCase() : "";
    if (!email) throw APIError.invalidArgument("email is required");

    const [invitee] = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!invitee) {
      // Naming the address back is not a leak: the caller typed it.
      throw APIError.notFound(`niemand mit der Adresse ${email} — erst einladen, dann mitplanen`);
    }

    const [plan] = await db
      .select({ ownerId: tripPlans.owner_id })
      .from(tripPlans)
      .where(eq(tripPlans.id, req.planId))
      .limit(1);
    if (plan?.ownerId === invitee.id) {
      throw APIError.alreadyExists("diese Person hat die Reise angelegt");
    }

    const existing = await db
      .select({ id: tripPlanShares.id })
      .from(tripPlanShares)
      .where(and(
        eq(tripPlanShares.plan_id, req.planId),
        eq(tripPlanShares.user_id, invitee.id),
      ))
      .limit(1);

    // Inviting somebody twice is the same invitation, not a second one.
    if (existing.length === 0) {
      await db.insert(tripPlanShares).values({
        plan_id: req.planId,
        user_id: invitee.id,
        invited_by: userId,
      });
    }

    return {
      participant: {
        userId: invitee.id,
        name: invitee.name,
        email: invitee.email,
        role: "participant",
      },
      added: existing.length === 0,
    };
  },
);

export interface RemoveParticipantRequest {
  planId: number;
  userId: number;
}

export interface RemoveParticipantResponse {
  removed: boolean;
}

export const removeFromTrip = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/participants/remove",
    auth: true,
  },
  async (req: RemoveParticipantRequest): Promise<RemoveParticipantResponse> => {
    const caller = requireUser();
    // Leaving a trip yourself is not one of the organiser's rights —
    // it is nobody's business but yours, and needing to ask permission
    // to stop planning somebody else's holiday would be absurd.
    if (req.userId !== caller) {
      await requireOrganiser(req.planId, caller, "Wer mitplant");
    } else if (!(await isOnTrip(req.planId, caller))) {
      throw APIError.notFound("plan not found");
    }

    const [plan] = await db
      .select({ ownerId: tripPlans.owner_id })
      .from(tripPlans)
      .where(eq(tripPlans.id, req.planId))
      .limit(1);
    if (!plan) throw APIError.notFound("plan not found");
    if (plan.ownerId === req.userId) {
      // Removing the organiser would leave a trip nobody can invite
      // anybody back to. Handing the role over is a different action
      // and does not exist yet (§6.2: "die Rolle ist übertragbar").
      throw APIError.failedPrecondition(
        "die Person, die die Reise angelegt hat, lässt sich nicht entfernen",
      );
    }

    const deleted = await db
      .delete(tripPlanShares)
      .where(and(
        eq(tripPlanShares.plan_id, req.planId),
        eq(tripPlanShares.user_id, req.userId),
      ))
      .returning({ id: tripPlanShares.id });

    return { removed: deleted.length > 0 };
  },
);

async function findUser(id: number) {
  const [row] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
