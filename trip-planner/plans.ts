/**
 * Persisted plans and redistribution — HTTP endpoints.
 *
 * Step 3 of docs/ios-urlaubsplanung.md §13. Step 2 computed a day and
 * threw it away; here a plan is stored so the mechanic the concept
 * calls its core can work on it: "we are here, it is now", the pool,
 * and moving what no longer fits to a following day.
 *
 * A plan is a list of **legs** (§4.2). Each has its own anchor, way of
 * getting around and region database, and therefore its own pool —
 * redistribution stays inside a leg, so what falls out in Tokyo does not
 * slide to Osaka. A one-city trip is a plan with one leg, which is why
 * the flat single-anchor request still works and simply builds one.
 *
 * The decisions stay in the pure modules (`solver.ts`,
 * `redistribute.ts`); these endpoints only load, call, and save.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { DEFAULT_DAY, shapeDay, type BlockTemplate, type GroupProfile, type Pace } from "./blocks";
import { toCandidates, type ScoredCandidate } from "./candidates";
import { requireOrganiser } from "./plan-access";
import {
  createPending,
  slugToPostgresDb,
  suggestForCoord,
} from "../osm-admin/region.service";
import { isCalendarDate, redateLegs } from "./leg-dates";
import { redistribute, type CurrentBlock, type StopStatus } from "./redistribute";
import { MoveError, moveStop } from "./move";
import { solveDay, type PlannedBlock } from "./solver";
import { DEFAULT_MAX_WALK_MINUTES, type TransportMode } from "./travel";
import {
  parseMinutes,
  scheduleDay,
  type DroppedBlock,
  type Fixpoint,
  type FixpointKind,
} from "./fixpoints";
import {
  createPlan,
  listPlans,
  loadPlan,
  saveMovedDays,
  setStopPinned,
  setStopStatus,
  saveDayDetail,
  saveRedistribution,
  renamePlan,
  deletePlan,
  replanPlan,
  setLegsAwaitingRegion,
  updateLegFrames,
  type LegFrameUpdate,
  type CreateDayInput,
  type CreateFixpointInput,
  type CreateLegInput,
  type PlanSummary,
  type StoredPlan,
} from "./plan-store";

const DEFAULT_SEARCH_RADIUS_M = 2_500;
const MAX_SEARCH_RADIUS_M = 20_000;
const CANDIDATE_LIMIT = 150;
const MAX_DAYS = 14;
/** More than this is a life, not a trip — and every leg costs a search. */
const MAX_LEGS = 10;
const TRANSPORT_MODES: readonly TransportMode[] = ["foot", "bike", "transit", "car"];
const FIXPOINT_KINDS: readonly FixpointKind[] = ["appointment", "departure"];
/**
 * How many days of the trip are planned down to spots straight away
 * (§4.3). Two, because that is how far ahead anyone can usefully plan:
 * the weather beyond it is unknown, and after three days the travellers
 * know better what suits them than the planner did on day one. For a
 * weekend trip this covers everything, so both resolutions coincide.
 */
const DEFAULT_DETAIL_DAYS = 2;
const STOP_STATUSES: readonly StopStatus[] = ["planned", "done", "skipped"];

/** One stop on the trip: a place, a stretch of days, a way of getting around. */
export interface LegRequest {
  /** What to call it — usually the city. */
  title?: string;
  /** Where each day starts and ends. With `anchorRadiusM`, its centroid. */
  anchor: { lat: number; lon: number };
  /**
   * What the anchor is called: "Hotel Beispielhof", "Beispielstraße 1",
   * "Campingplatz am See". Distinct from `title`, which names the city
   * — one field could not be both, and picking a hotel on the map used
   * to name the whole trip after it.
   */
  anchorLabel?: string;
  /**
   * Set when nothing is booked yet and the base is only known as a zone
   * ("at most five metro stops from the main square"). The planner still
   * reckons with the centroid; recording the tolerance keeps the plan
   * from claiming an address it does not have (§4.2).
   */
  anchorRadiusM?: number;
  /** foot | bike | transit | car. On foot by default. */
  mode?: TransportMode;
  /** How many days this leg lasts. One by default. */
  days?: number;
  /** Search radius around this leg's anchor. */
  radiusM?: number;
  /** ISO date (YYYY-MM-DD) of the leg's first day, when the trip has dates. */
  startDate?: string;
  /** When the day starts, as "HH:MM". Defaults to 09:00. */
  dayStartsAt?: string;
  /** Hard times that frame individual days of this leg (§4.4). */
  fixpoints?: FixpointRequest[];
  /**
   * The journey *into* this leg.
   *
   * On the first leg only `arriveAt` is read: how the travellers
   * reached the first city is not this plan's business, but *when* they
   * get there decides whether day one has a morning at all — and a
   * planner that gives a full Vormittag to a day the group spends on a
   * plane has promised something nobody has.
   */
  transfer?: TransferRequest;
}

/**
 * The move from the previous leg to this one (§4.2).
 *
 * A transfer is not dead time between two plans, it is a fixpoint that
 * eats half a day at each end: the day you leave has no evening, and
 * the day you arrive has no morning. Both ends are expressed with
 * machinery that already exists — a `departure` fixpoint on the last
 * day of the leg you are leaving, and a later start on the first day of
 * the one you are entering — so nothing in the solver has to learn what
 * a transfer is.
 *
 * What lies *on* the way is a separate question, answered by
 * `POST /trip-planner/corridor`. Keeping the two apart is deliberate:
 * how the day is framed does not depend on whether anyone wants to stop.
 */
export interface TransferRequest {
  /** When you leave the previous leg's city, as "HH:MM". */
  departAt?: string;
  /** When you reach this leg's anchor, as "HH:MM". */
  arriveAt?: string;
  /** What to call it. Defaults to naming the leg you are going to. */
  label?: string;
  /** The way to the station or airport from the previous anchor. */
  travelMinutes?: number;
  /** Margin in front of the departure. Defaults to 20, never below 5. */
  bufferMinutes?: number;
}

/**
 * A hard clock time on one day of a leg.
 *
 * `kind` is the field that matters: after an `appointment` the day goes
 * on, after a `departure` it is over. Calling a last train an
 * appointment would plan an evening block behind a train that has
 * already left.
 */
export interface FixpointRequest {
  /** Which day of the leg, counted from zero. */
  dayIndex: number;
  label: string;
  /** "18:40". */
  at: string;
  kind?: FixpointKind;
  /** How long it occupies. Zero for a departure. */
  durationMinutes?: number;
  /** The way there, in minutes. */
  travelMinutes?: number;
  /** Margin in front of it. Defaults to 20, never below 5. */
  bufferMinutes?: number;
  lat?: number;
  lon?: number;
}

export interface CreatePlanRequest {
  title?: string;
  /**
   * The legs of the trip, in order. A single-city trip may instead pass
   * the flat `anchor`/`days`/`radiusM` fields below, which build one leg.
   */
  legs?: LegRequest[];
  /** Shorthand for a one-leg trip. Ignored when `legs` is given. */
  anchor?: { lat: number; lon: number };
  /** How many days to plan. One by default. */
  days?: number;
  radiusM?: number;
  /** These apply to the whole trip: who is travelling and what they like. */
  categories?: string[];
  interests?: string[];
  pace?: Pace;
  group?: GroupProfile;
  blocks?: BlockTemplate[];
  maxWalkMinutes?: number;
  dwellMinutes?: Record<string, number>;
  /**
   * How many days from the start of the trip to plan down to spots
   * (§4.3). Later days get their frame — blocks with budgets, fixpoints
   * — and stay at trip resolution until someone asks for them, usually
   * the evening before. Defaults to 2; pass the trip's length to plan
   * the lot, or 0 to plan none.
   */
  detailDays?: number;
}

export interface PlanResponse {
  plan: StoredPlan;
  /**
   * Legs whose OpenStreetMap region is not imported yet (§4.3). Their
   * days have their frame — blocks with budgets, fixpoints — and no
   * spots, and the import has been asked for. Empty for the ordinary
   * case, which is what makes it safe to ignore.
   */
  pendingRegions?: PendingRegionReport[];
  /**
   * Blocks the fixpoints left no room for, per leg and day. Empty for a
   * plan with no hard times. Reported rather than silently absent: "der
   * Zug lässt für den Abend keine Zeit mehr" is the sentence the app
   * shows (§8.3).
   */
  droppedBlocks?: DroppedBlockReport[];
}

export interface PendingRegionReport extends PendingRegion {
  legIndex: number;
  /** What to call the leg in a sentence. */
  legTitle: string | null;
}

export interface DroppedBlockReport extends DroppedBlock {
  legIndex: number;
  dayIndex: number;
}

export const createTripPlan = api(
  { expose: true, method: "POST", path: "/trip-planner/plans", auth: true },
  async (req: CreatePlanRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const legRequests = normalizeLegs(req);
    const maxWalkMinutes = validateMaxWalk(req.maxWalkMinutes);
    const shape = shapeDay(req.blocks ?? DEFAULT_DAY, req.pace ?? "normal", req.group);

    const prepared = applyTransfers(legRequests);
    const detailDays = validateDetailDays(req.detailDays);

    const legs: CreateLegInput[] = [];
    const droppedBlocks: DroppedBlockReport[] = [];
    const pendingRegions: PendingRegionReport[] = [];
    // The detail budget is spent across the trip in order, not per leg:
    // "the next two days" means the next two days, whichever leg they
    // fall in.
    let detailBudget = detailDays;
    for (const [legIndex, leg] of prepared.entries()) {
      const planned = await planLeg(leg.request, {
        shape,
        maxWalkMinutes,
        categories: req.categories,
        interests: req.interests,
        dwellMinutes: req.dwellMinutes,
        firstDayStartMinutes: leg.firstDayStartMinutes,
        detailDays: detailBudget,
      });
      legs.push(planned.leg);
      detailBudget = Math.max(0, detailBudget - planned.leg.days.length);
      for (const d of planned.dropped) droppedBlocks.push({ ...d, legIndex });
      if (planned.pending) {
        pendingRegions.push({
          ...planned.pending,
          legIndex,
          legTitle: leg.request.title ?? null,
        });
      }
    }

    const planId = await createPlan({
      ownerId: userId,
      title: req.title,
      constraints: {
        categories: req.categories ?? null,
        interests: req.interests ?? null,
        pace: req.pace ?? "normal",
        group: req.group ?? null,
        maxWalkMinutes,
      },
      legs,
    });

    const plan = await loadPlan(planId, userId);
    if (!plan) throw APIError.internal("plan vanished right after being written");
    return { plan, droppedBlocks, pendingRegions };
  },
);

/**
 * Changing how a trip is planned, after it was planned (§4.1, §6.2).
 *
 * The pace, who is travelling and what they like were settable exactly
 * once — when the plan was created — and nowhere afterwards. "Eher
 * gemütlich" is the sort of thing you learn on the second day, and §6.2
 * lists changing the frame among the three things the organiser may do.
 *
 * **Changing a setting re-plans the days**, and it has to: the pace and
 * the group scale a block's budget, so storing the value and leaving
 * the days alone would be a switch with nothing behind it. What
 * survives is the frame the traveller set — the legs, their anchors,
 * dates, modes and search radius — plus every pool entry a person put
 * there themselves (§9.2). What is thrown away is the solver's choice
 * of spots, which is the thing the new setting is meant to change.
 *
 * **It refuses once a stop has been settled.** A day with something
 * ticked off is a record of what happened, and re-planning it would
 * rewrite that to match a setting changed afterwards. Adjusting a day
 * you are standing in has its own mechanism and its own name —
 * `POST …/redistribute` (§5, §8.5) — and the refusal says so rather
 * than leaving the traveller to work it out.
 */
export interface UpdateSettingsRequest {
  planId: number;
  /** Every field is optional; an omitted one keeps its stored value. */
  title?: string;
  pace?: Pace;
  group?: GroupProfile;
  categories?: string[];
  interests?: string[];
  maxWalkMinutes?: number;
  /**
   * How the group gets around, for every leg of the trip (§4.2).
   *
   * The mode belongs to the leg, and a trip through three cities may
   * genuinely want three different ones; this sets them all, because
   * that is the question the settings screen asks. Changing it
   * re-plans: the mode decides what is reachable within a block, so
   * storing it and leaving the days alone would be a switch with
   * nothing behind it.
   */
  mode?: TransportMode;
  /**
   * When the trip starts, as `YYYY-MM-DD`, or null to take the dates
   * off again (§6.2 — "das Gerüst ändern: Zeitraum").
   *
   * Every leg moves with it, keeping the gaps between them. This does
   * **not** re-plan and is not refused once a day has begun: which
   * museum to see does not depend on the date, and a trip whose flight
   * moved should not have to be planned again.
   */
  startDate?: string | null;
  /**
   * Rebuild the days from the new settings. True by default. Pass false
   * to record the change and leave the plan exactly as it stands.
   */
  replan?: boolean;
}

export const updateTripSettings = api(
  { expose: true, method: "PATCH", path: "/trip-planner/plans/:planId/settings", auth: true },
  async (req: UpdateSettingsRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    // Changing the frame is the organiser's, and only theirs (§6.2).
    // Everything else on a trip — contributing spots, re-planning on
    // the road — stays open to everybody who is on it.
    await requireOrganiser(req.planId, userId, "Tempo und Begleitung");

    if (req.title !== undefined) {
      await renamePlan(req.planId, userId, req.title.trim() || null);
    }

    // Not `validateMode` on its own: there, an absent mode means "on
    // foot", and here it means "leave it as it is".
    const mode = req.mode === undefined ? undefined : validateMode(req.mode);

    // A change that only moves the frame — the name, the dates — is not
    // a re-plan and is never refused: which museum to see does not
    // depend on what day it is, and a flight that moved must not cost
    // the traveller their plan.
    const replan = (req.replan ?? true) && changesTheDays(req, mode);

    // Before anything is written, so a refusal leaves the trip exactly
    // as it was rather than with a new mode and the old days.
    const settled = replan ? firstSettledStop(plan) : null;
    if (settled) {
      throw APIError.failedPrecondition(
        `„${settled}" ist schon abgehakt — ein begonnener Tag wird nicht neu geplant. `
          + "Unterwegs hilft „Umplanen“; oder die Einstellung mit replan=false nur speichern.",
      );
    }

    await moveFrame(plan, mode, req.startDate);

    if (!replan) {
      await replanPlan(req.planId, mergedConstraints(plan.constraints, req), []);
      return { plan: await reload(req.planId, userId) };
    }

    return await replanFromStoredSettings(
      plan,
      userId,
      mergedConstraints(plan.constraints, req),
      { mode },
    );
  },
);

/**
 * Re-plan every leg of a trip from its stored settings.
 *
 * Shared by changing a setting and by filling in a trip that was saved
 * before its region existed: both throw away the solver's choice of
 * spots and keep everything else. One copy, because the list of what
 * survives — legs, anchors, dates, the search radius, the pool entries
 * a person added — is exactly the part that goes quietly wrong when it
 * is written twice.
 */
async function replanFromStoredSettings(
  plan: StoredPlan,
  userId: number,
  override?: Record<string, unknown>,
  frame?: { mode?: TransportMode },
): Promise<PlanResponse> {
  const constraints = override ?? plan.constraints;
        const pace = constraints.pace as Pace;
    const group = (constraints.group ?? undefined) as GroupProfile | undefined;
    const maxWalkMinutes = validateMaxWalk((constraints.maxWalkMinutes ?? undefined) as number | undefined);
    const shape = shapeDay(DEFAULT_DAY, pace, group);

    const perLeg: Array<{ legId: number; days: CreateDayInput[]; pool: ScoredCandidate[] }> = [];
    const awaiting: Array<{ legId: number; awaiting: boolean }> = [];
    const droppedBlocks: DroppedBlockReport[] = [];
    const pendingRegions: PendingRegionReport[] = [];
    for (const leg of plan.legs) {
      const planned = await planLeg(
        { ...legRequestFromStored(leg), mode: frame?.mode ?? leg.mode },
        {
          // The stored arrival, replayed. Without it every settings
          // change handed back a morning the group spends travelling.
          firstDayStartMinutes: leg.arriveMinutes,
          shape,
          maxWalkMinutes,
          categories: (constraints.categories ?? undefined) as string[] | undefined,
          interests: (constraints.interests ?? undefined) as string[] | undefined,
          // How far a day is planned out stays as it was: re-planning
          // answers "what should we see", not "how far ahead".
          detailDays: leg.days.filter((d) => d.detailed).length,
        },
      );
      perLeg.push({
        legId: leg.id,
        days: [...planned.leg.days] as CreateDayInput[],
        pool: [...planned.leg.pool],
      });
      awaiting.push({ legId: leg.id, awaiting: planned.pending !== null });
      for (const d of planned.dropped) droppedBlocks.push({ ...d, legIndex: leg.position });
      if (planned.pending) {
        pendingRegions.push({ ...planned.pending, legIndex: leg.position, legTitle: leg.title });
      }
    }

  await replanPlan(plan.id, constraints, perLeg);
  // Whether each leg is still waiting is decided here, by whether the
  // region answered this time — not by whoever called us.
  await setLegsAwaitingRegion(awaiting);
  return { plan: await reload(plan.id, userId), droppedBlocks, pendingRegions };
}

async function reload(planId: number, userId: number): Promise<StoredPlan> {
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.internal("plan vanished while it was being written");
  return plan;
}

/**
 * The first stop anybody has settled, by name.
 *
 * A name rather than a boolean: "„Stadtmuseum“ ist schon abgehakt" is a
 * sentence the traveller can act on; "the trip has started" leaves them
 * hunting for what started it.
 */
function firstSettledStop(plan: StoredPlan): string | null {
  for (const leg of plan.legs) {
    for (const day of leg.days) {
      for (const block of day.blocks) {
        for (const stop of block.stops) {
          if (stop.status !== "planned") return stop.name ?? stop.osmRef;
        }
      }
    }
  }
  return null;
}

/**
 * Does this change need the days planned again?
 *
 * The pace, the group, the interests, the longest walk and the mode all
 * decide what fits in a block, so each of them makes the stored days
 * stale. The name and the dates do not. Getting this wrong in the
 * generous direction is not harmless: an unnecessary re-plan throws
 * away the solver's arrangement of a trip and is refused outright once
 * a day has begun, so renaming a running trip would fail for no reason.
 */
function changesTheDays(req: UpdateSettingsRequest, mode: TransportMode | undefined): boolean {
  return mode !== undefined
    || req.pace !== undefined
    || req.group !== undefined
    || req.categories !== undefined
    || req.interests !== undefined
    || req.maxWalkMinutes !== undefined;
}

/**
 * Write the two frame properties a settings change may move: the mode
 * of every leg, and when the trip starts.
 *
 * Both are on the legs rather than in the constraints, which is why
 * they cannot ride along in `mergedConstraints`. Writing the mode here
 * as well as passing it to the re-plan is deliberate: the re-plan
 * rewrites days, not legs, and a mode that only reached the solver
 * would be back to the old value on the next one.
 */
async function moveFrame(
  plan: StoredPlan,
  mode: TransportMode | undefined,
  startDate: string | null | undefined,
): Promise<void> {
  const updates = new Map<number, LegFrameUpdate>();
  if (mode !== undefined) {
    for (const leg of plan.legs) updates.set(leg.id, { legId: leg.id, mode });
  }
  if (startDate !== undefined) {
    if (startDate === null) {
      for (const leg of plan.legs) {
        updates.set(leg.id, { ...updates.get(leg.id), legId: leg.id, startDate: null });
      }
    } else {
      if (!isCalendarDate(startDate)) {
        throw APIError.invalidArgument(`startDate must be YYYY-MM-DD, got '${startDate}'`);
      }
      const dated = redateLegs(
        [...plan.legs]
          .sort((a, b) => a.position - b.position)
          .map((leg) => ({ legId: leg.id, startDate: leg.startDate, days: leg.days.length })),
        startDate,
      );
      for (const leg of dated) {
        updates.set(leg.legId, { ...updates.get(leg.legId), legId: leg.legId, startDate: leg.startDate });
      }
    }
  }
  if (updates.size > 0) await updateLegFrames(plan.id, [...updates.values()]);
}

/**
 * Stored settings plus what the request changed. An omitted field keeps
 * its value — a screen changing the pace must not quietly drop the
 * interests along with it.
 */
function mergedConstraints(
  stored: Record<string, unknown>,
  req: UpdateSettingsRequest,
): Record<string, unknown> {
  return {
    categories: req.categories ?? stored.categories ?? null,
    interests: req.interests ?? stored.interests ?? null,
    pace: req.pace ?? stored.pace ?? "normal",
    group: req.group ?? stored.group ?? null,
    maxWalkMinutes: req.maxWalkMinutes ?? stored.maxWalkMinutes ?? null,
  };
}

/**
 * Plan one leg with the trip's own settings (§4.2).
 *
 * The bridge between "a trip has settings" and "a leg is planned": pace
 * and group shape the day, the interests and the longest walk steer the
 * choice, and all four live on the trip rather than on the leg. Exported
 * because adding a city to an existing trip needs exactly this and must
 * not grow a second reading of the same constraints — a leg added on
 * Tuesday has to come out like a leg named at the start.
 */
export async function planLegForTrip(
  plan: StoredPlan,
  request: LegRequest,
  options: { detailDays: number; firstDayStartMinutes?: number | null },
): Promise<{
  leg: CreateLegInput;
  dropped: Array<DroppedBlock & { dayIndex: number }>;
  pending: PendingRegion | null;
}> {
  const constraints = plan.constraints;
  const shape = shapeDay(
    DEFAULT_DAY,
    constraints.pace as Pace,
    (constraints.group ?? undefined) as GroupProfile | undefined,
  );
  return await planLeg(request, {
    shape,
    maxWalkMinutes: validateMaxWalk(
      (constraints.maxWalkMinutes ?? undefined) as number | undefined),
    categories: (constraints.categories ?? undefined) as string[] | undefined,
    interests: (constraints.interests ?? undefined) as string[] | undefined,
    detailDays: options.detailDays,
    firstDayStartMinutes: options.firstDayStartMinutes,
  });
}

/**
 * A stored leg, read back as the request that would produce it.
 *
 * The frame the traveller set, in the shape `planLeg` takes: anchor,
 * mode, length, search radius, date, day start and every fixpoint,
 * including the departure a transfer left on the last day. Everything
 * that re-plans a leg goes through here, so "what survives a re-plan"
 * is one list rather than one per caller.
 */
export function legRequestFromStored(leg: StoredPlan["legs"][number]): LegRequest {
  return {
    title: leg.title ?? undefined,
    anchor: leg.anchor,
    anchorRadiusM: leg.anchorRadiusM ?? undefined,
    anchorLabel: leg.anchorLabel ?? undefined,
    mode: leg.mode,
    transfer: leg.arriveMinutes === null
      ? undefined
      : { arriveAt: formatMinutesOfDay(leg.arriveMinutes) },
    days: leg.days.length,
    radiusM: leg.radiusM ?? undefined,
    startDate: leg.startDate ?? undefined,
    dayStartsAt: leg.dayStartMinutes === null
      ? undefined
      : formatMinutesOfDay(leg.dayStartMinutes),
    fixpoints: leg.days.flatMap((day) =>
      day.fixpoints.map((f) => ({
        dayIndex: day.dayIndex,
        label: f.label,
        at: formatMinutesOfDay(f.startMinutes),
        kind: f.kind,
        durationMinutes: f.durationMinutes,
        travelMinutes: f.travelMinutes,
        bufferMinutes: f.bufferMinutes,
        lat: f.lat ?? undefined,
        lon: f.lon ?? undefined,
      }))),
  };
}

/** Minutes past midnight back to the "HH:MM" the request types use. */
function formatMinutesOfDay(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

export interface ListPlansResponse {
  plans: PlanSummary[];
}

/**
 * The user's plans, newest first — what the app needs to offer a
 * choice. A summary rather than the plans themselves: a twenty-day trip
 * carries hundreds of stops, and choosing one needs a name, a length
 * and a date.
 */
export const listTripPlans = api(
  { expose: true, method: "GET", path: "/trip-planner/plans", auth: true },
  async (): Promise<ListPlansResponse> => {
    const userId = requireUser();
    return { plans: await listPlans(userId) };
  },
);

export const getTripPlan = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId", auth: true },
  async ({ planId }: { planId: number }): Promise<PlanResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    return { plan };
  },
);

export interface DetailDayRequestBody {
  planId: number;
  /** Which leg. The first one by default. */
  legIndex?: number;
  /** Which day of that leg, counted from zero within the leg. */
  dayIndex: number;
}

/**
 * Bring one day from trip resolution to day resolution (§4.3) — the
 * thing the travellers do the evening before.
 *
 * The day already has its frame: blocks with budgets, and whatever
 * fixpoints bind it. All that is missing is the spots, and they come
 * out of the leg's pool, which is where the planning result has lived
 * all along. So this is the same solve the create endpoint does, just
 * deferred until it is worth doing.
 *
 * Detailing a day that is already detailed is refused rather than
 * silently redone: it would quietly discard whatever the travellers had
 * pinned or already visited, and the endpoint for changing a planned
 * day is `redistribute`.
 */
export const detailTripDay = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/days/detail",
    auth: true,
  },
  async (req: DetailDayRequestBody): Promise<PlanResponse> => {
    const userId = requireUser();

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${legIndex}`);

    if (day.detailed) {
      throw APIError.failedPrecondition(
        "this day is already planned — use redistribute to change it",
      );
    }

    const maxWalkMinutes =
      typeof plan.constraints.maxWalkMinutes === "number"
        ? plan.constraints.maxWalkMinutes
        : DEFAULT_MAX_WALK_MINUTES;

    // The stored blocks already carry the budgets the fixpoints left
    // them, so the frame does not have to be recomputed here.
    const solved = solveDay({
      anchor: leg.anchor,
      blocks: day.blocks.map((b) => ({
        id: b.id,
        label: b.label,
        kind: b.kind,
        baseBudgetMinutes: b.budgetMinutes,
        budgetMinutes: b.budgetMinutes,
      })),
      candidates: leg.pool,
      maxWalkMinutes,
      mode: leg.mode,
    });

    const placed = new Set(solved.blocks.flatMap((b) => b.stops.map((st) => st.osmRef)));
    const remaining = leg.pool.filter((c) => !placed.has(c.osmRef));

    await saveDayDetail(
      plan.id,
      leg.id,
      day,
      solved.blocks.map((b) => ({
        ...b,
        stops: b.stops.map((st) => ({ ...st, status: "planned" as const, pinned: false })),
      })),
      remaining,
    );

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while detailing a day");
    return { plan: updated, droppedBlocks: [] };
  },
);

export interface StopStatusRequestBody {
  planId: number;
  /** The stop's row id, as the plan returns it. */
  stopId: number;
  /** done | skipped | planned — the last one undoes a mistaken swipe. */
  status: StopStatus;
}

/**
 * Tick a spot off, or skip it (§8.5).
 *
 * Its own endpoint rather than a redistribution on purpose: marking a
 * stop done is not a request to replan the day, and treating it as one
 * would rearrange the afternoon under the traveller's thumb. What it
 * does do is set what a later redistribution reads as "past" (§5).
 */
export const setTripStopStatus = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/stops/status",
    auth: true,
  },
  async (req: StopStatusRequestBody): Promise<PlanResponse> => {
    const userId = requireUser();
    if (!STOP_STATUSES.includes(req.status)) {
      throw APIError.invalidArgument(`status must be one of ${STOP_STATUSES.join(", ")}`);
    }
    if (!Number.isInteger(req.stopId)) {
      throw APIError.invalidArgument("stopId must be a stop's row id");
    }

    const changed = await setStopStatus(req.planId, userId, req.stopId, req.status);
    if (!changed) throw APIError.notFound("stop not found in this plan");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    return { plan, droppedBlocks: [] };
  },
);

export interface PinStopRequestBody {
  planId: number;
  stopId: number;
  pinned: boolean;
}

/**
 * Pin a stop, or release it (§8.4). A pinned stop is a fixed point:
 * redistribution keeps it where it is, whatever else moves (§5).
 */
export const pinTripStop = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/stops/pin", auth: true },
  async (req: PinStopRequestBody): Promise<PlanResponse> => {
    const userId = requireUser();
    if (!Number.isInteger(req.stopId)) {
      throw APIError.invalidArgument("stopId must be a stop's row id");
    }
    const changed = await setStopPinned(req.planId, userId, req.stopId, req.pinned === true);
    if (!changed) throw APIError.notFound("stop not found in this plan");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    return { plan, droppedBlocks: [] };
  },
);

export interface MoveStopRequestBody {
  planId: number;
  /** The stop being dragged, by row id. */
  stopId: number;
  /** Which leg. Moves never cross legs — see below. */
  legIndex?: number;
  /** Which day of that leg to drop it in. */
  toDayIndex: number;
  /** Which block of that day. */
  toBlockId: string;
  /** Where in the block, from zero. Past the end, or omitted, means last. */
  toPosition?: number;
}

export interface MoveStopResponseBody {
  plan: StoredPlan;
  /**
   * Blocks now over their budget — the ones the app turns red (§8.4).
   * Reported rather than refused: the traveller dragged it there on
   * purpose, and a rejected gesture says less than a red block.
   */
  overfullBlockIds: string[];
}

/**
 * Drag a spot to another block, or another day (§8.4).
 *
 * The arithmetic is `move.ts`, which recomputes the walks of every
 * affected day rather than patching two blocks — a block starts where
 * the previous one left off, so a move ripples.
 *
 * **Within one leg only.** Redistribution is scoped to a leg because a
 * leg has its own anchor, its own way of getting around and its own
 * region (§4.2); a spot dragged from Tokyo into an Osaka day would be
 * measured against the wrong anchor and reached by the wrong mode. The
 * endpoint says so rather than doing something plausible-looking.
 */
export const moveTripStop = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/stops/move", auth: true },
  async (req: MoveStopRequestBody): Promise<MoveStopResponseBody> => {
    const userId = requireUser();

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    const sourceDay = leg.days.find((d) =>
      d.blocks.some((b) => b.stops.some((s) => s.rowId === req.stopId)),
    );
    if (!sourceDay) {
      throw APIError.notFound(`stop ${req.stopId} not found in leg ${legIndex}`);
    }
    const targetDay = leg.days.find((d) => d.dayIndex === req.toDayIndex);
    if (!targetDay) {
      throw APIError.notFound(`day ${req.toDayIndex} not found in leg ${legIndex}`);
    }
    if (!targetDay.detailed) {
      // A day at trip resolution has a frame but no stops (§4.3).
      // Dropping one in would half-plan it behind the traveller's back.
      throw APIError.failedPrecondition(
        "that day is not planned yet — plan it first, then move spots into it",
      );
    }

    const osmRef = sourceDay.blocks
      .flatMap((b) => b.stops)
      .find((s) => s.rowId === req.stopId)!.osmRef;

    let moved;
    try {
      moved = moveStop({
        fromBlocks: sourceDay.blocks,
        toBlocks: sourceDay.id === targetDay.id ? sourceDay.blocks : targetDay.blocks,
        osmRef,
        toBlockId: req.toBlockId,
        toPosition: req.toPosition,
        anchor: leg.anchor,
        mode: leg.mode,
      });
    } catch (err) {
      if (err instanceof MoveError) throw APIError.invalidArgument(err.message);
      throw err;
    }

    const days =
      sourceDay.id === targetDay.id
        ? [{ day: sourceDay, blocks: moved.fromBlocks }]
        : [
            { day: sourceDay, blocks: moved.fromBlocks },
            { day: targetDay, blocks: moved.toBlocks },
          ];
    await saveMovedDays(plan.id, days);

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while moving a spot");
    return { plan: updated, overfullBlockIds: moved.overfullBlockIds };
  },
);

export interface DeletePlanRequest {
  planId: number;
}

export interface DeletePlanResponse {
  deleted: boolean;
}

/**
 * Delete a trip (§6.2).
 *
 * There was no way to do this at all, which made the plan list a
 * one-way street: a trip typed to try the planner out stayed there for
 * good. Everything else in the planner is reversible, so this being the
 * one exception was not a decision, it was an omission.
 *
 * **The organiser's, and only theirs.** §6.2 reserves changing the
 * frame to the person who created the trip, and deleting it is the
 * largest possible change to the frame — it takes the trip away from
 * everybody it was shared with, not only from the person tapping.
 * Somebody who merely wants out has `…/participants/remove` and needs
 * nobody's permission for it.
 *
 * The stops, days, pool and share rows go with it: they cascade from
 * the plan and mean nothing without it.
 */
export const deleteTripPlan = api(
  { expose: true, method: "DELETE", path: "/trip-planner/plans/:planId", auth: true },
  async (req: DeletePlanRequest): Promise<DeletePlanResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Die Reise löschen");

    const deleted = await deletePlan(req.planId);
    if (!deleted) throw APIError.notFound("plan not found");
    return { deleted: true };
  },
);

export interface RedistributeRequestBody {
  planId: number;
  /** Which leg of the trip. The first one by default (§4.2). */
  legIndex?: number;
  /** Which day of that leg, counted from zero within the leg. */
  dayIndex: number;
  /** The block the group is standing in. */
  currentBlockId: string;
  /** Minutes left of that block. */
  remainingMinutes: number;
  position: { lat: number; lon: number };
  /** Stop row ids that have been visited. */
  visited?: number[];
  /** Stop row ids to skip. */
  skipped?: number[];
}

export interface RedistributeResponseBody {
  plan: StoredPlan;
  /** What lost its place — the sentence to show the user (§5). */
  displaced: { osmRef: string; name: string | null }[];
}

export const redistributeDay = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/redistribute",
    auth: true,
  },
  async (req: RedistributeRequestBody): Promise<RedistributeResponseBody> => {
    const userId = requireUser();
    const position = validateAnchor(req.position);
    if (!Number.isFinite(req.remainingMinutes) || req.remainingMinutes < 0) {
      throw APIError.invalidArgument("remainingMinutes must be zero or positive");
    }

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${legIndex}`);

    const visited = new Set(req.visited ?? []);
    const skipped = new Set(req.skipped ?? []);
    const blocks: CurrentBlock[] = day.blocks.map((block) => ({
      ...block,
      stops: block.stops.map((stop) => ({
        ...stop,
        status: visited.has(stop.rowId)
          ? ("done" as const)
          : skipped.has(stop.rowId)
            ? ("skipped" as const)
            : stop.status,
      })),
    }));

    const maxWalkMinutes =
      typeof plan.constraints.maxWalkMinutes === "number"
        ? plan.constraints.maxWalkMinutes
        : DEFAULT_MAX_WALK_MINUTES;

    let result;
    try {
      result = redistribute({
        blocks,
        // The leg's own pool: a spot in Osaka is not a replacement for
        // one missed in Tokyo (§4.2).
        pool: leg.pool,
        position,
        anchor: leg.anchor,
        currentBlockId: req.currentBlockId,
        remainingMinutes: Math.round(req.remainingMinutes),
        maxWalkMinutes,
        mode: leg.mode,
      });
    } catch (err) {
      throw APIError.invalidArgument((err as Error).message);
    }

    await saveRedistribution(plan.id, leg.id, day, result.blocks, result.pool);

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished during redistribution");
    return {
      plan: updated,
      displaced: result.displaced.map((c) => ({ osmRef: c.osmRef, name: c.name })),
    };
  },
);

/**
 * "Plant es jetzt" — fill in a trip that was saved before its region
 * was ready (§4.3).
 *
 * The counterpart to saving a plan whose OpenStreetMap region is still
 * importing: the days have had their frame all along, and this is what
 * puts spots in them. It plans the whole trip rather than one leg,
 * because a trip with one city filled in and another empty is a state
 * nobody asked for and the arithmetic is the same either way.
 *
 * Refuses while a region is still missing, naming which — "es lädt
 * noch" is an answer the traveller can wait on; an empty day with no
 * explanation is not.
 */
/**
 * Plan a trip that was saved without its maps (§4.3).
 *
 * The endpoint below and the worker in `fill-pending.ts` are the two
 * callers, and they must not differ: what survives a fill-in — the
 * legs, their anchors, dates, modes, the search radius and every pool
 * entry somebody added by hand (§9.2) — is exactly the list that goes
 * quietly wrong when it is written twice.
 */
export async function fillPendingPlan(
  plan: StoredPlan,
  userId: number,
): Promise<PlanResponse> {
  return await replanFromStoredSettings(plan, userId);
}

export const planPendingTrip = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/plan", auth: true },
  async (req: { planId: number }): Promise<PlanResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const settled = firstSettledStop(plan);
    if (settled) {
      throw APIError.failedPrecondition(
        `„${settled}" ist schon abgehakt — dieser Plan ist nicht mehr ungeplant.`,
      );
    }

    const waiting: string[] = [];
    for (const leg of plan.legs) {
      if (await pickRegion(leg.anchor.lat, leg.anchor.lon)) continue;
      waiting.push(leg.title ?? `Etappe ${leg.position + 1}`);
    }
    if (waiting.length > 0) {
      throw APIError.failedPrecondition(
        `die Karten für ${waiting.join(", ")} sind noch nicht da — `
          + "der Import läuft oder wartet auf Freigabe.",
      );
    }

    return await replanFromStoredSettings(plan, userId);
  },
);

/**
 * One leg's search and solve. Days are solved one after another out of
 * a shrinking pool, so the same spot is never planned twice — within
 * the leg. Across legs the pools are separate by construction, because
 * each leg searches its own region around its own anchor.
 */
async function planLeg(
  legReq: LegRequest,
  trip: {
    shape: ReturnType<typeof shapeDay>;
    maxWalkMinutes: number;
    categories?: string[];
    interests?: string[];
    dwellMinutes?: Record<string, number>;
    /** When day 0 begins, when a transfer pushed it back. */
    firstDayStartMinutes?: number | null;
    /** How many of this leg's days to plan down to spots (§4.3). */
    detailDays?: number;
  },
): Promise<{
  leg: CreateLegInput;
  dropped: Array<DroppedBlock & { dayIndex: number }>;
  /** Set when this leg is waiting for its region to be imported. */
  pending: PendingRegion | null;
}> {
  const anchor = validateAnchor(legReq.anchor);
  const radiusM = validateRadius(legReq.radiusM);
  const dayCount = validateDays(legReq.days);
  const mode = validateMode(legReq.mode);
  const anchorRadiusM = validateAnchorRadius(legReq.anchorRadiusM);
  const startDate = validateStartDate(legReq.startDate);
  const dayStartMinutes = validateTimeOfDay(legReq.dayStartsAt, "dayStartsAt");
  const fixpointsByDay = groupFixpoints(legReq.fixpoints, dayCount);

  // No imported region here yet. The trip is still worth saving: §4.3
  // already has a resolution for "framed but not filled in", and a
  // refusal at this point throws away everything the traveller typed
  // over a download nobody asked them to arrange. The import is
  // requested, the days get their frame, and the spots come later.
  const region = await pickRegion(anchor.lat, anchor.lon);
  const pending = region ? null : await requestRegion(anchor);

  const page = region
    ? await getGeoClient().searchPois(region.postgresDb, {
        center: { lat: anchor.lat, lon: anchor.lon, radiusM },
        categories: trip.categories,
        limit: CANDIDATE_LIMIT,
      })
    // Zero candidates is exactly a frame: the solver fills the budget it
    // is given, and given nothing it produces blocks with no stops.
    : { spots: [] };

  const scored = toCandidates(page.spots, {
    interests: trip.interests,
    dwellMinutes: trip.dwellMinutes,
    // This pool is what a day gets built out of, so it holds only what
    // is worth a block. A lookup ("what is near me") asks its own
    // question and keeps the ordinary.
    requireProminence: true,
  });

  let available = [...scored];
  const days: CreateDayInput[] = [];
  const dropped: Array<DroppedBlock & { dayIndex: number }> = [];

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    // The fixpoints frame the day before anything is placed in it: the
    // solver fills the budget it is given and never learns what a clock
    // is (§4.4).
    const fixpoints = fixpointsByDay.get(dayIndex) ?? [];
    // An arrival pushes only the first day back; the rest of the leg
    // starts when the leg says it starts.
    const arrival = dayIndex === 0 ? trip.firstDayStartMinutes ?? null : null;
    const startsAt = arrival !== null
      ? Math.max(arrival, dayStartMinutes ?? 0)
      : dayStartMinutes;
    const framed = scheduleDay({
      blocks: trip.shape,
      fixpoints: fixpoints.map((f) => f.fixpoint),
      dayStartMinutes: startsAt ?? undefined,
      // Only an arrival makes the day begin later than the shape
      // assumes; a leg that simply starts at half past seven moves the
      // whole day forward rather than losing its front.
      nominalStartMinutes: arrival !== null ? dayStartMinutes ?? undefined : undefined,
    });
    for (const d of framed.dropped) dropped.push({ ...d, dayIndex });

    // Beyond the detail horizon the day keeps its frame and stays
    // empty: the pool *is* the plan at trip resolution (§4.3), and
    // filling day nineteen now would only be undone by the weather.
    const detailed = dayIndex < (trip.detailDays ?? Number.POSITIVE_INFINITY);
    // The hour each block begins is part of the frame, so it is kept
    // whether or not the day has spots yet (§8.3).
    const startsByBlock = new Map(framed.blocks.map((b) => [b.id, b.startMinutes]));

    if (!detailed) {
      days.push({
        blocks: framed.blocks.map((b) => ({ ...b, usedMinutes: 0, stops: [] })),
        fixpoints: fixpoints.map((f) => f.stored),
        detailed: false,
      });
      continue;
    }

    const solved = solveDay({
      anchor,
      blocks: framed.blocks,
      candidates: available,
      maxWalkMinutes: trip.maxWalkMinutes,
      mode,
    });
    days.push({
      blocks: solved.blocks.map((b) => ({ ...b, startMinutes: startsByBlock.get(b.id) })),
      fixpoints: fixpoints.map((f) => f.stored),
      detailed: true,
    });
    const placed = new Set(solved.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
    available = available.filter((c) => !placed.has(c.osmRef));
  }

  return {
    leg: {
      title: legReq.title,
      anchor,
      anchorRadiusM,
      mode,
      // Known before the import finishes: the database name follows
      // from the slug, so the leg can point at where its data will be.
      anchorLabel: legReq.anchorLabel?.trim() || null,
      // Kept on the leg so a re-plan cannot hand the morning back: the
      // arrival used to live in the request and nowhere else.
      arriveMinutes: trip.firstDayStartMinutes ?? null,
      regionDb: region?.postgresDb ?? pending!.postgresDb,
      // The leg says it is waiting, rather than the waiting being
      // guessed from "has no stops" — which a leg whose search
      // genuinely found nothing also looks like (migration 0168).
      awaitingRegion: region === null,
      startDate,
      // Kept with the leg so a re-plan searches the same area at the
      // same hour rather than falling back to the defaults (0165).
      radiusM,
      dayStartMinutes,
      days,
      pool: available,
    },
    dropped,
    pending,
  };
}

export interface PendingRegion {
  /** The Geofabrik region asked for, e.g. "europe/portugal/lisboa". */
  slug: string;
  /** pending_approval | importing | … — what the admin queue says. */
  status: string;
  postgresDb: string;
  /** True when nobody has to do anything: it is already downloading. */
  autoApproved: boolean;
}

/**
 * Ask for the region this anchor needs.
 *
 * Goes through the same `createPending` the region admin uses, and so
 * inherits its policy rather than routing around it: a small region
 * starts importing at once, a large one waits for an admin. A traveller
 * planning a trip does not get to commit the server to a fifty-gigabyte
 * download by typing a city name.
 *
 * Idempotent — a region already tracked comes back with whatever status
 * it has, which is what makes a second trip to the same place cheap.
 */
async function requestRegion(anchor: { lat: number; lon: number }): Promise<PendingRegion> {
  let suggestion;
  try {
    suggestion = await suggestForCoord(anchor.lat, anchor.lon);
  } catch (err) {
    // Working out *which* region is a lookup against Geofabrik's index,
    // so it can fail for reasons that have nothing to do with the trip.
    // Saying which beats a five-hundred.
    throw APIError.unavailable(
      "das Regionsverzeichnis von Geofabrik ist gerade nicht erreichbar — "
        + `ohne das lässt sich nicht sagen, welche Karten dieser Ort braucht (${(err as Error).message})`,
    );
  }
  if (!suggestion) {
    throw APIError.failedPrecondition(
      "für diesen Ort gibt es keine OpenStreetMap-Region bei Geofabrik — "
        + "liegt er vielleicht auf dem Meer?",
    );
  }
  const created = await createPending(suggestion.slug);
  return {
    slug: suggestion.slug,
    status: created.status,
    postgresDb: slugToPostgresDb(suggestion.slug),
    autoApproved: created.status === "importing",
  };
}

/**
 * Turn each leg's `transfer` into the two things the planner already
 * understands: a `departure` fixpoint on the last day of the leg being
 * left, and a later start on the first day of the leg being entered.
 *
 * Doing it here rather than in the solver is the point. A transfer day
 * is not a new kind of day — it is an ordinary day with a hard edge at
 * one end, and the machinery for hard edges exists (§4.4).
 *
 * A transfer on the first leg is ignored: nobody transfers into the
 * start of the trip, and how the travellers reached it is not this
 * plan's business.
 */
export function applyTransfers(
  legRequests: readonly LegRequest[],
): Array<{ request: LegRequest; firstDayStartMinutes: number | null }> {
  const prepared = legRequests.map((request) => ({
    request: { ...request, fixpoints: [...(request.fixpoints ?? [])] },
    firstDayStartMinutes: null as number | null,
  }));

  for (const [legIndex, leg] of prepared.entries()) {
    const transfer = leg.request.transfer;
    if (!transfer) continue;

    const arriveAt = validateTimeOfDay(transfer.arriveAt, `legs[${legIndex}].transfer.arriveAt`);
    const departAt = validateTimeOfDay(transfer.departAt, `legs[${legIndex}].transfer.departAt`);
    const label = transfer.label?.trim() || `Weiterreise${leg.request.title ? ` nach ${leg.request.title}` : ""}`;

    // The arrival is read on every leg, the first one included. Nobody
    // transfers *into* the start of a trip — but they do arrive there,
    // and a first day that begins at 09:00 for a group landing at 14:00
    // is a morning the plan invented.
    if (arriveAt !== null) leg.firstDayStartMinutes = arriveAt;

    // The departure belongs to the leg *before* this one, and the first
    // leg has none: there is no day to put it on.
    if (legIndex === 0) continue;

    if (departAt !== null) {
      // The departure belongs to the day you are leaving, which is the
      // previous leg's last one.
      const previous = prepared[legIndex - 1];
      const previousDayCount = validateDays(previous.request.days);
      previous.request.fixpoints!.push({
        dayIndex: previousDayCount - 1,
        label,
        at: transfer.departAt!,
        kind: "departure",
        travelMinutes: transfer.travelMinutes,
        bufferMinutes: transfer.bufferMinutes,
      });
    }
  }

  return prepared;
}

/**
 * Validate the leg's fixpoints and file them under the day they belong
 * to. A fixpoint on a day the leg does not have is a mistake worth
 * naming rather than a row nothing ever reads.
 */
function groupFixpoints(
  requests: FixpointRequest[] | undefined,
  dayCount: number,
): Map<number, Array<{ fixpoint: Fixpoint; stored: CreateFixpointInput }>> {
  const byDay = new Map<number, Array<{ fixpoint: Fixpoint; stored: CreateFixpointInput }>>();
  if (!requests) return byDay;
  if (!Array.isArray(requests)) {
    throw APIError.invalidArgument("fixpoints must be an array");
  }

  for (const [i, req] of requests.entries()) {
    if (!Number.isInteger(req.dayIndex) || req.dayIndex < 0 || req.dayIndex >= dayCount) {
      throw APIError.invalidArgument(
        `fixpoints[${i}].dayIndex must be between 0 and ${dayCount - 1} for this leg`,
      );
    }
    const label = typeof req.label === "string" ? req.label.trim() : "";
    if (!label) throw APIError.invalidArgument(`fixpoints[${i}].label is required`);

    const startMinutes = validateTimeOfDay(req.at, `fixpoints[${i}].at`);
    if (startMinutes === null) {
      throw APIError.invalidArgument(`fixpoints[${i}].at is required`);
    }
    const kind = req.kind ?? "appointment";
    if (!FIXPOINT_KINDS.includes(kind)) {
      throw APIError.invalidArgument(
        `fixpoints[${i}].kind must be one of ${FIXPOINT_KINDS.join(", ")}`,
      );
    }

    const shared = {
      // The row id is not known yet; the day index and position are
      // enough to be unique within the day being scheduled.
      id: `${req.dayIndex}:${i}`,
      label,
      kind,
      startMinutes,
      durationMinutes: nonNegativeMinutes(req.durationMinutes, `fixpoints[${i}].durationMinutes`),
      travelMinutes: nonNegativeMinutes(req.travelMinutes, `fixpoints[${i}].travelMinutes`),
      bufferMinutes: req.bufferMinutes === undefined
        ? undefined
        : nonNegativeMinutes(req.bufferMinutes, `fixpoints[${i}].bufferMinutes`),
    };

    const list = byDay.get(req.dayIndex) ?? [];
    list.push({
      fixpoint: shared,
      stored: { ...shared, lat: req.lat ?? null, lon: req.lon ?? null },
    });
    byDay.set(req.dayIndex, list);
  }
  return byDay;
}

function validateTimeOfDay(text: string | undefined, label: string): number | null {
  if (text === undefined) return null;
  const minutes = typeof text === "string" ? parseMinutes(text) : null;
  if (minutes === null) {
    throw APIError.invalidArgument(`${label} must be a time of day as HH:MM, got '${text}'`);
  }
  return minutes;
}

function nonNegativeMinutes(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw APIError.invalidArgument(`${label} must be zero or a positive number of minutes`);
  }
  return Math.round(value);
}

/**
 * `legs` wins; the flat fields are the one-leg shorthand a weekend trip
 * uses. Accepting both keeps the simple request simple without giving
 * the planner two notions of what a plan is — everything downstream
 * sees legs.
 */
function normalizeLegs(req: CreatePlanRequest): LegRequest[] {
  if (req.legs !== undefined) {
    if (!Array.isArray(req.legs) || req.legs.length === 0) {
      throw APIError.invalidArgument("legs must be a non-empty array");
    }
    if (req.legs.length > MAX_LEGS) {
      throw APIError.invalidArgument(`a plan may have at most ${MAX_LEGS} legs`);
    }
    return req.legs;
  }
  if (!req.anchor) {
    throw APIError.invalidArgument("either legs or anchor is required");
  }
  return [{ anchor: req.anchor, days: req.days, radiusM: req.radiusM }];
}

function validateDetailDays(days: number | undefined): number {
  if (days === undefined) return DEFAULT_DETAIL_DAYS;
  if (!Number.isFinite(days) || days < 0) {
    throw APIError.invalidArgument("detailDays must be zero or a positive number of days");
  }
  return Math.floor(days);
}

export function validateMode(mode: TransportMode | undefined): TransportMode {
  if (mode === undefined) return "foot";
  if (!TRANSPORT_MODES.includes(mode)) {
    throw APIError.invalidArgument(`mode must be one of ${TRANSPORT_MODES.join(", ")}`);
  }
  return mode;
}

function validateAnchorRadius(radiusM: number | undefined): number | null {
  if (radiusM === undefined) return null;
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw APIError.invalidArgument("anchorRadiusM must be a positive number");
  }
  if (radiusM > MAX_SEARCH_RADIUS_M) {
    throw APIError.invalidArgument(`anchorRadiusM may be at most ${MAX_SEARCH_RADIUS_M} m`);
  }
  return Math.round(radiusM);
}

function validateStartDate(date: string | undefined): string | null {
  if (date === undefined) return null;
  // Date-only, and no timezone anywhere near it: a leg starts on a day,
  // not at an instant.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw APIError.invalidArgument(`startDate must be YYYY-MM-DD, got '${date}'`);
  }
  return date;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function validateAnchor(anchor: { lat: number; lon: number } | undefined): { lat: number; lon: number } {
  if (!anchor || typeof anchor !== "object") {
    throw APIError.invalidArgument("a coordinate is required");
  }
  const { lat, lon } = anchor;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument(`lat out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument(`lon out of range: ${lon}`);
  }
  return { lat, lon };
}

function validateRadius(radiusM: number | undefined): number {
  if (radiusM === undefined) return DEFAULT_SEARCH_RADIUS_M;
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw APIError.invalidArgument("radiusM must be a positive number");
  }
  if (radiusM > MAX_SEARCH_RADIUS_M) {
    throw APIError.invalidArgument(`radiusM may be at most ${MAX_SEARCH_RADIUS_M} m`);
  }
  return Math.round(radiusM);
}

function validateDays(days: number | undefined): number {
  if (days === undefined) return 1;
  if (!Number.isFinite(days) || days < 1) {
    throw APIError.invalidArgument("days must be at least 1");
  }
  if (days > MAX_DAYS) {
    throw APIError.invalidArgument(`days may be at most ${MAX_DAYS}`);
  }
  return Math.floor(days);
}

function validateMaxWalk(minutes: number | undefined): number {
  if (minutes === undefined) return DEFAULT_MAX_WALK_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw APIError.invalidArgument("maxWalkMinutes must be a positive number");
  }
  return Math.round(minutes);
}
