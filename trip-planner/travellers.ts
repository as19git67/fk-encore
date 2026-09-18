/**
 * The travel group, from the people rather than from a sentence (§3.5).
 *
 * Three calls and one rule. The rule is that this is not the guest
 * list: `trip_plan_shares` holds the people who may *plan* the trip
 * (§6.2), and this holds the people who are *on* it — a four-year-old
 * has no account and still decides how long the afternoon may be.
 *
 * What it changes: `blocks.ts` has always shrunk a block's budget for
 * `withChildren` and again for `limitedMobility`, and the packing list
 * reads the same flags. Until now they came from a sentence somebody
 * typed once. Now they are derived from who is coming, for the date the
 * trip starts — so a child who has had two birthdays since the trip was
 * described is planned for as the child they are, not the one they
 * were.
 *
 * Adding or removing a traveller therefore re-plans the trip, exactly
 * as a fixpoint or a pace change does: the blocks have different
 * budgets afterwards, and a day whose budgets moved but whose spots did
 * not is a day that no longer adds up. For the same reason it is the
 * organiser's call (§6.2, "Tempo und Begleitung").
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import {
  tripPlanShares,
  tripPlanTravellers,
  userSubjectPersons,
  users,
} from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { isOnTrip, requireOrganiser } from "./plan-access";
import { loadPlan, type StoredPlan } from "./plan-store";
import { replanAfterFrameChange, type PlanResponse } from "./plans";
import {
  ageOn,
  readGroup,
  withGroup,
  type GroupReading,
  type Traveller,
} from "./travel-group";
import { samePerson } from "./same-person";

export interface TravellersRequest {
  planId: number;
}

export interface TripTraveller {
  id: number;
  /** The household entry this is, when it is one. */
  subjectPersonId: number | null;
  label: string;
  /** From the household entry, or the row's own. Null when unknown. */
  birthDate: string | null;
  /** Set by a person, never derived (§3.5). */
  shortWalks: boolean;
  /** Age at the start of the trip, which is the age that plans it. */
  ageAtStart: number | null;
  addedBy: string | null;
}

export interface TravellersResponse {
  travellers: TripTraveller[];
  /** The date the ages were computed against, or null when undated. */
  on: string | null;
  /** What follows from the group, and why (§3.8). */
  effect: { withChildren: boolean; limitedMobility: boolean; reasons: string[] };
}

export interface TravellerSuggestion {
  /**
   * The household entry, when this suggestion is one. Null for a
   * participant of the trip who is not in the household list: an
   * account is a person too, and having to type their name again
   * because they happen to hold a login is the kind of gap that makes
   * an app feel unfinished.
   */
  subjectPersonId: number | null;
  /** The account, when the suggestion is a fellow planner (§6.2). */
  userId: number | null;
  label: string;
  relation: string;
  birthDate: string | null;
  ageAtStart: number | null;
}

export interface TravellerSuggestionsResponse {
  suggestions: TravellerSuggestion[];
}

export interface AddTravellerRequest {
  planId: number;
  /** One of the household, by its id. */
  subjectPersonId?: number;
  /** Or somebody who plans this trip, by their account (§6.2). */
  userId?: number;
  /** Or somebody who is not: their name, and optionally a birth date. */
  label?: string;
  birthDate?: string;
  /** "Kürzere Wege" — a statement about a person, so it is asked for. */
  shortWalks?: boolean;
}

export interface RemoveTravellerRequest {
  planId: number;
  travellerId: number;
}

export interface UpdateTravellerRequest {
  planId: number;
  travellerId: number;
  /** "Kürzere Wege" — a statement about a person, so it is asked for. */
  shortWalks?: boolean;
  /** A new name for somebody entered by hand. */
  label?: string;
  /**
   * A birth date for somebody entered by hand, or null to take it
   * away. A household entry's date comes from the household and is
   * not edited here.
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

/**
 * The household, as people who could be coming.
 *
 * Offered, not added: a trip is not automatically everybody who lives
 * in the house, and taking the household along by default would make
 * "wer fährt mit" a question the app answered for itself.
 */
export const suggestTravellers = api(
  {
    expose: true,
    method: "GET",
    path: "/trip-planner/plans/:planId/travellers/suggestions",
    auth: true,
  },
  async (req: TravellersRequest): Promise<TravellerSuggestionsResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const already = new Set(
      (await db
        .select({ id: tripPlanTravellers.subject_person_id })
        .from(tripPlanTravellers)
        .where(eq(tripPlanTravellers.plan_id, req.planId)))
        .map((row) => row.id)
        .filter((id): id is number => id !== null),
    );

    const household = await householdOf(userId);

    // The people who plan this trip are people on it too (§6.2, §3.5).
    // Leaving them out meant an adult with a login had to be entered
    // twice — once by e-mail as a planner, once by hand as a traveller.
    const planners = await plannersOf(plan);
    const alreadyByUser = new Set(
      (await db
        .select({ id: tripPlanTravellers.added_for_user_id })
        .from(tripPlanTravellers)
        .where(eq(tripPlanTravellers.plan_id, req.planId)))
        .map((row) => row.id)
        .filter((id): id is number => id !== null),
    );
    // A planner who is also in the household appears once, as the
    // household entry: that one knows their birth date. "Also in the
    // household" is decided by `same-person.ts`, not by an exact name:
    // the organiser is "Max Beispiel (Ehemann)" in their own household
    // and "Max" as an account, and was offered twice.
    const inHousehold = (planner: (typeof planners)[number]) =>
      household.some((person) => samePerson(person, planner));
    // Already on the trip under the other record: the account was
    // added, so its household entry is not offered — and the other way
    // round.
    const onTripAsAccount = (person: (typeof household)[number]) =>
      planners.some((planner) => alreadyByUser.has(planner.id) && samePerson(person, planner));

    const on = startOf(plan);
    return {
      suggestions: [
        ...household
          .filter((person) => !already.has(person.id))
          .filter((person) => !onTripAsAccount(person))
          .map((person) => ({
            subjectPersonId: person.id,
            userId: null,
            label: person.name,
            relation: person.relation,
            birthDate: person.birthDate,
            ageAtStart: on === null ? null : ageOn(person.birthDate, on),
          })),
        ...planners
          .filter((person) => !alreadyByUser.has(person.id))
          .filter((person) => !inHousehold(person))
          .map((person) => ({
            subjectPersonId: null,
            userId: person.id,
            label: person.name,
            relation: "plant mit",
            birthDate: null,
            ageAtStart: null,
          })),
      ],
    };
  },
);

/** "Die Kinder kommen mit." */
export const addTraveller = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/travellers", auth: true },
  async (req: AddTravellerRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Wer mitfährt");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const label = req.label?.trim();
    if (req.subjectPersonId === undefined && req.userId === undefined && !label) {
      throw APIError.invalidArgument("entweder subjectPersonId, userId oder ein Name");
    }

    if (req.userId !== undefined) {
      // Only somebody who is actually on this trip: an account id from
      // elsewhere must not turn into a name on somebody's travel list.
      const [planner] = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, req.userId))
        .limit(1);
      if (!planner || !(await isOnTrip(req.planId, planner.id))) {
        throw APIError.notFound("diese Person plant diese Reise nicht mit");
      }
      const [existing] = await db
        .select({ id: tripPlanTravellers.id })
        .from(tripPlanTravellers)
        .where(and(
          eq(tripPlanTravellers.plan_id, req.planId),
          eq(tripPlanTravellers.added_for_user_id, planner.id),
        ))
        .limit(1);
      if (existing) throw APIError.alreadyExists("diese Person fährt schon mit");
      // Or already on the trip as their household entry: one human, one
      // row (`same-person.ts`).
      const twin = (await householdOf(userId)).find((person) => samePerson(person, planner));
      if (twin && await isTravellerBySubject(req.planId, twin.id)) {
        throw APIError.alreadyExists("diese Person fährt schon mit — als Haushaltseintrag");
      }

      await db.insert(tripPlanTravellers).values({
        plan_id: req.planId,
        added_for_user_id: planner.id,
        label: label || planner.name,
        short_walks: req.shortWalks === true,
        added_by: userId,
      });
      return await replanWithGroup(req.planId, userId);
    }

    if (req.subjectPersonId !== undefined) {
      // Only the caller's own household: an id from somewhere else must
      // not turn into a name on somebody's trip.
      const person = (await householdOf(userId, false)).find((p) => p.id === req.subjectPersonId);
      if (!person) throw APIError.notFound("person not found");

      if (await isTravellerBySubject(req.planId, person.id)) {
        throw APIError.alreadyExists("diese Person fährt schon mit");
      }
      // Or already on the trip as their account (`same-person.ts`).
      const asAccount = (await plannersOf(plan)).find((planner) => samePerson(person, planner));
      if (asAccount) {
        const [viaAccount] = await db
          .select({ id: tripPlanTravellers.id })
          .from(tripPlanTravellers)
          .where(and(
            eq(tripPlanTravellers.plan_id, req.planId),
            eq(tripPlanTravellers.added_for_user_id, asAccount.id),
          ))
          .limit(1);
        if (viaAccount) {
          throw APIError.alreadyExists("diese Person fährt schon mit — über ihr Konto");
        }
      }

      await db.insert(tripPlanTravellers).values({
        plan_id: req.planId,
        subject_person_id: person.id,
        // Copied so the row stays readable if the household entry goes.
        label: label || person.name,
        short_walks: req.shortWalks === true,
        added_by: userId,
      });
    } else {
      await db.insert(tripPlanTravellers).values({
        plan_id: req.planId,
        label: label as string,
        birth_date: validBirthDate(req.birthDate),
        short_walks: req.shortWalks === true,
        added_by: userId,
      });
    }

    return await replanWithGroup(req.planId, userId);
  },
);

/**
 * "Oma braucht doch kürzere Wege."
 *
 * The flag was settable only at the moment somebody was added, and the
 * app never asked then — so it was displayed and never true. It is a
 * statement about a person (§3.5), and people change their minds about
 * people, so it is editable afterwards like the name of somebody who
 * has no household entry to carry it.
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
        subjectPersonId: tripPlanTravellers.subject_person_id,
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
    if (req.label !== undefined) {
      const label = req.label.trim();
      if (!label) throw APIError.invalidArgument("der Name darf nicht leer sein");
      patch.label = label;
    }
    if (req.birthDate !== undefined) {
      if (row.subjectPersonId !== null) {
        throw APIError.failedPrecondition(
          "das Geburtsdatum kommt aus dem Haushalt und wird dort geändert",
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

/** "Doch ohne die Kinder." */
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

    const gone = await db
      .delete(tripPlanTravellers)
      .where(and(
        eq(tripPlanTravellers.plan_id, req.planId),
        eq(tripPlanTravellers.id, req.travellerId),
      ))
      .returning({ id: tripPlanTravellers.id });
    if (gone.length === 0) {
      throw APIError.notFound("diese Person fährt bei dieser Reise nicht mit");
    }

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
 */
async function replanWithGroup(planId: number, userId: number): Promise<PlanResponse> {
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.internal("plan vanished while changing the travel group");
  const { effect } = await travellersOf(plan);
  const constraints = withGroup(plan.constraints, {
    withChildren: effect.withChildren || undefined,
    limitedMobility: effect.limitedMobility || undefined,
  });
  return await replanAfterFrameChange(plan, userId, constraints);
}

/**
 * The trip's travellers, with the household's birth dates joined in.
 *
 * Exported so the readiness screen and the settings screen can show the
 * same sentences without a second reading of the same rule.
 */
export async function travellersOf(plan: StoredPlan): Promise<TravellersResponse> {
  const rows = await db
    .select({
      id: tripPlanTravellers.id,
      subjectPersonId: tripPlanTravellers.subject_person_id,
      label: tripPlanTravellers.label,
      ownBirthDate: tripPlanTravellers.birth_date,
      shortWalks: tripPlanTravellers.short_walks,
      householdBirthDate: userSubjectPersons.birth_date,
      addedBy: users.name,
    })
    .from(tripPlanTravellers)
    .leftJoin(userSubjectPersons, eq(userSubjectPersons.id, tripPlanTravellers.subject_person_id))
    .leftJoin(users, eq(users.id, tripPlanTravellers.added_by))
    .where(eq(tripPlanTravellers.plan_id, plan.id))
    .orderBy(asc(tripPlanTravellers.created_at));

  const on = startOf(plan);
  const people: Traveller[] = rows.map((row) => ({
    label: row.label,
    // The household entry wins: that is where a correction lands.
    birthDate: row.householdBirthDate ?? row.ownBirthDate,
    shortWalks: row.shortWalks,
  }));
  const reading: GroupReading = readGroup(people, on);

  return {
    travellers: rows.map((row, i) => ({
      id: row.id,
      subjectPersonId: row.subjectPersonId,
      label: row.label,
      birthDate: people[i].birthDate ?? null,
      shortWalks: row.shortWalks,
      ageAtStart: on === null ? null : ageOn(people[i].birthDate, on),
      addedBy: row.addedBy,
    })),
    on,
    effect: {
      withChildren: reading.group.withChildren === true,
      limitedMobility: reading.group.limitedMobility === true,
      reasons: reading.reasons,
    },
  };
}

/** The trip's first dated day — the age that plans it (§3.5). */
/**
 * The caller's household as the travel group sees it — with the
 * relation kind, which is the one field that can say "this is me".
 */
async function householdOf(userId: number, onlyInHousehold = true) {
  const rows = await db
    .select({
      id: userSubjectPersons.id,
      name: userSubjectPersons.full_name,
      relation: userSubjectPersons.relation_tag,
      relationKind: userSubjectPersons.relation_kind,
      birthDate: userSubjectPersons.birth_date,
    })
    .from(userSubjectPersons)
    .where(onlyInHousehold
      ? and(eq(userSubjectPersons.user_id, userId), eq(userSubjectPersons.in_household, true))
      : eq(userSubjectPersons.user_id, userId))
    .orderBy(asc(userSubjectPersons.full_name));
  return rows.map((row) => ({ ...row, ownerId: userId }));
}

/** The accounts that plan this trip: the organiser and everybody shared with. */
async function plannersOf(plan: StoredPlan) {
  return await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [
      plan.ownerId,
      ...(await db
        .select({ id: tripPlanShares.user_id })
        .from(tripPlanShares)
        .where(eq(tripPlanShares.plan_id, plan.id))).map((row) => row.id),
    ]));
}

async function isTravellerBySubject(planId: number, subjectPersonId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: tripPlanTravellers.id })
    .from(tripPlanTravellers)
    .where(and(
      eq(tripPlanTravellers.plan_id, planId),
      eq(tripPlanTravellers.subject_person_id, subjectPersonId),
    ))
    .limit(1);
  return row !== undefined;
}

function startOf(plan: StoredPlan): string | null {
  return plan.legs
    .map((leg) => leg.startDate)
    .filter((date): date is string => date !== null)
    .sort()[0] ?? null;
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
