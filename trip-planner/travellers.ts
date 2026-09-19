/**
 * The travel group, from the people rather than from a sentence (§3.5).
 *
 * One rule: whoever plans the trip is on it. The accounts on the trip
 * (`trip_plan_shares` and the organiser) are the travel group's fixed
 * part — made and removed with the invitation, never by hand here.
 * Everybody without an account is the other part: a four-year-old has
 * no login and still decides how long the afternoon may be, so they
 * are entered by name and, if known, birth date.
 *
 * It used to be three lists — accounts, the organiser's household from
 * the documents module, and hand entries — and the first two describe
 * the same adults twice, joined by nothing better than a name. The
 * household is gone from here; the album share picks from accounts,
 * and so does this.
 *
 * What it changes: `blocks.ts` has always shrunk a block's budget for
 * `withChildren` and again for `limitedMobility`, and the packing list
 * reads the same flags. They are derived from who is coming, for the
 * date the trip starts — so a child who has had two birthdays since
 * the trip was described is planned for as the child they are.
 *
 * Adding or removing a traveller therefore re-plans the trip, exactly
 * as a fixpoint or a pace change does: the blocks have different
 * budgets afterwards, and a day whose budgets moved but whose spots did
 * not is a day that no longer adds up. For the same reason it is the
 * organiser's call (§6.2, "Tempo und Begleitung").
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db from "../db/database";
import {
  tripPlanShares,
  tripPlanTravellers,
  userSubjectPersons,
  users,
} from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { requireOrganiser } from "./plan-access";
import { loadPlan, type StoredPlan } from "./plan-store";
import { replanAfterFrameChange, type PlanResponse } from "./plans";
import {
  ageOn,
  GETS_ABOUT,
  isGetsAbout,
  readGroup,
  withGroup,
  type GetsAbout,
  type GroupReading,
  type Traveller,
} from "./travel-group";

/** `users` a second time: who added a hand entry, beside who the row is. */
const addedByUser = alias(users, "added_by_user");

export interface TravellersRequest {
  planId: number;
}

export interface TripTraveller {
  id: number;
  /**
   * The account, when this traveller has one. Such a row is on the
   * trip because they plan it, and leaves with the invitation.
   */
  userId: number | null;
  label: string;
  /**
   * For an account: from their own household entry when they keep one,
   * else what was entered here. For everybody else: the row's own.
   * Null when unknown.
   */
  birthDate: string | null;
  /** True when the date comes from the account's own household. */
  birthDateFromHousehold: boolean;
  /** Set by a person, never derived (§3.5). */
  shortWalks: boolean;
  /** foot | wheelchair | pram — how they get about (§3.5). */
  getsAbout: string;
  /** Age at the start of the trip, which is the age that plans it. */
  ageAtStart: number | null;
  addedBy: string | null;
}

export interface TravellersResponse {
  travellers: TripTraveller[];
  /** The date the ages were computed against, or null when undated. */
  on: string | null;
  /** What follows from the group, and why (§3.8). */
  effect: {
    withChildren: boolean;
    limitedMobility: boolean;
    /** Somebody is on wheels: routes that climb are out (§4.7). */
    onWheels: boolean;
    reasons: string[];
  };
}

export interface AddTravellerRequest {
  planId: number;
  /** Somebody without an account: their name, and optionally a birth date. */
  label: string;
  birthDate?: string;
  /** "Mehr Zeit einplanen" — a statement about a person, so it is asked for. */
  shortWalks?: boolean;
  /** foot | wheelchair | pram. Omitted means on foot (§3.5). */
  getsAbout?: string;
}

export interface RemoveTravellerRequest {
  planId: number;
  travellerId: number;
}

export interface UpdateTravellerRequest {
  planId: number;
  travellerId: number;
  /** "Mehr Zeit einplanen" — a statement about a person, so it is asked for. */
  shortWalks?: boolean;
  /** foot | wheelchair | pram (§3.5). */
  getsAbout?: string;
  /** A new name for somebody entered by hand. */
  label?: string;
  /**
   * A birth date, or null to take it away. Not for an account whose
   * own household knows the date: that is where a correction lands.
   */
  birthDate?: string | null;
}

/** Who is coming, and what that does to the days. */
export const planTravellers = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/travellers", auth: true },
  async (req: TravellersRequest): Promise<TravellersResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    return await travellersOf(plan);
  },
);

/** "Die Kinder kommen mit." — somebody without an account. */
export const addTraveller = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/travellers", auth: true },
  async (req: AddTravellerRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Wer mitfährt");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const label = typeof req.label === "string" ? req.label.trim() : "";
    if (!label) throw APIError.invalidArgument("ein Name wird gebraucht");

    await db.insert(tripPlanTravellers).values({
      plan_id: req.planId,
      label,
      birth_date: validBirthDate(req.birthDate),
      short_walks: req.shortWalks === true,
      gets_about: validGetsAbout(req.getsAbout),
      added_by: userId,
    });

    return await replanWithGroup(req.planId, userId);
  },
);

/**
 * "Oma braucht doch mehr Zeit."
 *
 * The flag was settable only at the moment somebody was added, and the
 * app never asked then — so it was displayed and never true. It is a
 * statement about a person (§3.5), and people change their minds about
 * people, so it is editable afterwards, like the name and birth date
 * of somebody entered by hand.
 */
export const updateTraveller = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/travellers/update",
    auth: true,
  },
  async (req: UpdateTravellerRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Wer mitfährt");

    const [row] = await db
      .select({
        id: tripPlanTravellers.id,
        userId: tripPlanTravellers.added_for_user_id,
      })
      .from(tripPlanTravellers)
      .where(and(
        eq(tripPlanTravellers.id, req.travellerId),
        eq(tripPlanTravellers.plan_id, req.planId),
      ))
      .limit(1);
    if (!row) throw APIError.notFound("diese Person fährt bei dieser Reise nicht mit");

    const patch: Partial<typeof tripPlanTravellers.$inferInsert> = {};
    if (req.shortWalks !== undefined) patch.short_walks = req.shortWalks;
    if (req.getsAbout !== undefined) patch.gets_about = validGetsAbout(req.getsAbout);
    if (req.label !== undefined) {
      if (row.userId !== null) {
        throw APIError.failedPrecondition("der Name kommt aus dem Konto und wird dort geändert");
      }
      const label = req.label.trim();
      if (!label) throw APIError.invalidArgument("der Name darf nicht leer sein");
      patch.label = label;
    }
    if (req.birthDate !== undefined) {
      if (row.userId !== null && (await ownBirthDateOf(row.userId)) !== null) {
        throw APIError.failedPrecondition(
          "das Geburtsdatum kommt aus dem eigenen Haushalt der Person und wird dort geändert",
        );
      }
      patch.birth_date = req.birthDate === null ? null : validBirthDate(req.birthDate);
    }
    if (Object.keys(patch).length === 0) {
      throw APIError.invalidArgument("nichts zu ändern");
    }

    await db.update(tripPlanTravellers).set(patch).where(eq(tripPlanTravellers.id, row.id));
    return await replanWithGroup(req.planId, userId);
  },
);

/** "Doch ohne die Kinder." — somebody without an account. */
export const removeTraveller = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/travellers/remove",
    auth: true,
  },
  async (req: RemoveTravellerRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Wer mitfährt");

    const [row] = await db
      .select({ id: tripPlanTravellers.id, userId: tripPlanTravellers.added_for_user_id })
      .from(tripPlanTravellers)
      .where(and(
        eq(tripPlanTravellers.plan_id, req.planId),
        eq(tripPlanTravellers.id, req.travellerId),
      ))
      .limit(1);
    if (!row) throw APIError.notFound("diese Person fährt bei dieser Reise nicht mit");
    if (row.userId !== null) {
      // Whoever plans is on the trip. Taking them off the trip while
      // they still plan it would be two answers to one question; the
      // invitation is where they leave.
      throw APIError.failedPrecondition(
        "wer mitplant, fährt mit — unter „Planen mit“ entfernen",
      );
    }

    await db.delete(tripPlanTravellers).where(eq(tripPlanTravellers.id, row.id));
    return await replanWithGroup(req.planId, userId);
  },
);

/**
 * Read the group back and plan the trip against it.
 *
 * From the trip as it is *now* rather than from a snapshot taken before
 * the write, for the same reason the fixpoint calls do it: the
 * re-planner reads each leg back as the request that would produce it,
 * and a stale copy would plan the days around a group that changed a
 * moment ago.
 *
 * Exported for the invitation: somebody joining or leaving the planners
 * joins or leaves the group, and the days follow.
 */
export async function replanWithGroup(planId: number, userId: number): Promise<PlanResponse> {
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.internal("plan vanished while changing the travel group");
  const { effect } = await travellersOf(plan);
  const constraints = withGroup(plan.constraints, {
    withChildren: effect.withChildren || undefined,
    limitedMobility: effect.limitedMobility || undefined,
    onWheels: effect.onWheels || undefined,
  });
  return await replanAfterFrameChange(plan, userId, constraints);
}

/**
 * The trip's travellers: the accounts that plan it, then everybody
 * entered by hand.
 *
 * Exported so the readiness screen and the settings screen can show the
 * same sentences without a second reading of the same rule.
 */
export async function travellersOf(plan: StoredPlan): Promise<TravellersResponse> {
  await syncPlanners(plan);

  const rows = await db
    .select({
      id: tripPlanTravellers.id,
      userId: tripPlanTravellers.added_for_user_id,
      label: tripPlanTravellers.label,
      accountName: users.name,
      ownBirthDate: tripPlanTravellers.birth_date,
      shortWalks: tripPlanTravellers.short_walks,
      getsAbout: tripPlanTravellers.gets_about,
      addedBy: addedByUser.name,
    })
    .from(tripPlanTravellers)
    .leftJoin(users, eq(users.id, tripPlanTravellers.added_for_user_id))
    .leftJoin(addedByUser, eq(addedByUser.id, tripPlanTravellers.added_by))
    .where(eq(tripPlanTravellers.plan_id, plan.id))
    .orderBy(asc(tripPlanTravellers.created_at), asc(tripPlanTravellers.id));

  // An account's own household knows their birth date, when they keep
  // one; a correction lands there, so it wins over what was typed here.
  const householdDates = await ownBirthDatesOf(
    rows.map((row) => row.userId).filter((id): id is number => id !== null),
  );

  const on = startOf(plan);
  const people: (Traveller & { fromHousehold: boolean })[] = rows.map((row) => {
    const fromHousehold = row.userId !== null ? householdDates.get(row.userId) ?? null : null;
    return {
      label: row.accountName ?? row.label,
      birthDate: fromHousehold ?? row.ownBirthDate,
      fromHousehold: fromHousehold !== null,
      shortWalks: row.shortWalks,
      getsAbout: row.getsAbout,
    };
  });
  const reading: GroupReading = readGroup(people, on);

  return {
    travellers: rows.map((row, i) => ({
      id: row.id,
      userId: row.userId,
      label: people[i].label,
      birthDate: people[i].birthDate ?? null,
      birthDateFromHousehold: people[i].fromHousehold,
      shortWalks: row.shortWalks,
      getsAbout: row.getsAbout,
      ageAtStart: on === null ? null : ageOn(people[i].birthDate, on),
      addedBy: row.addedBy,
    })),
    on,
    effect: {
      withChildren: reading.group.withChildren === true,
      limitedMobility: reading.group.limitedMobility === true,
      onWheels: reading.group.onWheels === true,
      reasons: reading.reasons,
    },
  };
}

/**
 * Whoever plans the trip is on it: one row per account on the trip,
 * no row for an account that left.
 *
 * Done on every read rather than only at the invitation, so a trip
 * whose planners changed some other way — a hand-over, an older
 * database — is right the next time anybody looks. Idempotent: the
 * unique index on (plan_id, added_for_user_id) makes a second insert
 * a no-op.
 */
async function syncPlanners(plan: StoredPlan): Promise<void> {
  const planners = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, [
      plan.ownerId,
      ...(await db
        .select({ id: tripPlanShares.user_id })
        .from(tripPlanShares)
        .where(eq(tripPlanShares.plan_id, plan.id))).map((row) => row.id),
    ]));
  const plannerIds = planners.map((planner) => planner.id);

  if (planners.length > 0) {
    await db
      .insert(tripPlanTravellers)
      .values(planners.map((planner) => ({
        plan_id: plan.id,
        added_for_user_id: planner.id,
        label: planner.name ?? planner.email,
        added_by: plan.ownerId,
      })))
      .onConflictDoNothing();
  }
  // Somebody who stopped planning stopped travelling. Their votes by
  // proxy and branch memberships go with the row (ON DELETE CASCADE);
  // a person who is not on the trip has no say on it.
  await db
    .delete(tripPlanTravellers)
    .where(and(
      eq(tripPlanTravellers.plan_id, plan.id),
      isNotNull(tripPlanTravellers.added_for_user_id),
      plannerIds.length > 0
        ? notInArray(tripPlanTravellers.added_for_user_id, plannerIds)
        : sql`true`,
    ));
}

/** The birth date each account keeps for itself in its own household. */
async function ownBirthDatesOf(userIds: number[]): Promise<Map<number, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      userId: userSubjectPersons.user_id,
      birthDate: userSubjectPersons.birth_date,
    })
    .from(userSubjectPersons)
    .where(and(
      inArray(userSubjectPersons.user_id, userIds),
      eq(userSubjectPersons.relation_kind, "self"),
    ));
  const dates = new Map<number, string>();
  for (const row of rows) {
    if (row.birthDate) dates.set(row.userId, row.birthDate);
  }
  return dates;
}

async function ownBirthDateOf(userId: number): Promise<string | null> {
  return (await ownBirthDatesOf([userId])).get(userId) ?? null;
}

/** The trip's first dated day — the age that plans it (§3.5). */
function startOf(plan: StoredPlan): string | null {
  return plan.legs
    .map((leg) => leg.startDate)
    .filter((date): date is string => date !== null)
    .sort()[0] ?? null;
}

/**
 * The mode, or a refusal. Absent is "on foot", which is the ordinary
 * answer and the one nobody has to give.
 */
function validGetsAbout(value: string | undefined): GetsAbout {
  if (value === undefined) return "foot";
  const trimmed = value.trim();
  if (trimmed === "") return "foot";
  if (!isGetsAbout(trimmed)) {
    throw APIError.invalidArgument(`getsAbout must be one of ${GETS_ABOUT.join(", ")}`);
  }
  return trimmed;
}

function validBirthDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw APIError.invalidArgument("birthDate must be YYYY-MM-DD");
  }
  return trimmed;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
