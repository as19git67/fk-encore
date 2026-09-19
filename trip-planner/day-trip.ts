/**
 * The day trip nobody asked for (§4.6).
 *
 * > Ich sage nur „vier Tage in San Gimignano" — und Florenz, Pisa und
 * > Lucca sollen trotzdem im Plan vorkommen.
 *
 * That wish is legitimate and provable from the pool itself: a town of
 * seven thousand does not carry four days, and every person you ask
 * says "you are an hour from Florence". A planner that keeps quiet
 * about that is not restrained, it is useless.
 *
 * Against it stands one of the hardest rules in the concept: **the
 * planner invents no appointments** (§7.1). Sixty kilometres are not a
 * side effect of a place search, they are a decision about a day. The
 * resolution is the same one the evening light (§7.3) and the outing
 * from the collection (§20.2) use: **suggest, do not plan.**
 *
 * So there are three calls, and the split between them is the feature:
 *
 *   - **Looking** writes nothing at all, and most legs never get past
 *     its first question.
 *   - **Accepting** sets the day's anchor (§4.5) — the same call a
 *     person makes by hand, with the same organiser rule and the same
 *     re-plan afterwards. The destination is looked up again rather
 *     than taken from the request: where a day happens is not
 *     something a client should be able to state.
 *   - **Waving it away** is remembered (§6.4, §7.1). Said once, the
 *     suggestion does not come back for that place.
 *
 * ## Three questions, in this order, and each may end it
 *
 *  1. **Do the days carry?** Measured, not guessed (`thin-pool.ts`):
 *     even if everything left in the pool were planned, would a whole
 *     day of this leg still be empty? If not, there is nothing to say.
 *  2. **Is there anywhere to go?** Counted out of the region's own
 *     spots (`geo/src/day-targets.ts`), in a ring that starts outside
 *     the leg's own search — a day trip to where you already are is
 *     not a suggestion.
 *  3. **Would it be a day?** The drive comes out of that day's blocks,
 *     there and back, and what is left has to be a day worth having
 *     and the destination has to hold enough to fill it.
 *
 * ## One, not five
 *
 * An evening carries one outing, and five suggestions are a decision
 * rather than a hint (§20.2). So the answer is the strongest single
 * destination or none — and it says what it costs, because the whole
 * point is that the traveller can weigh it.
 *
 * The travel time is an estimate from the straight line and the leg's
 * mode (§12), and an hour may well be ninety minutes. It is labelled
 * as an estimate rather than quietly presented as a timetable.
 */

import { api, APIError } from "encore.dev/api";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripPlanDayTripDismissals } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient, type GeoDayTarget } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { loadPlan, type StoredLeg } from "./plan-store";
import { setTripDayAnchor } from "./day-anchor-edit";
import { measureThinPool, type ThinPoolVerdict } from "./thin-pool";
import { searchRadiusFor } from "./search-reach";
import type { PlanResponse } from "./plans";
import { haversineMeters, travelLeg, type Coordinate, type TransportMode } from "./travel";

/**
 * The longest one-way trip worth proposing, in minutes.
 *
 * Two hours each way is four hours of a day in transit; beyond that
 * the honest answer is a leg of its own, not a day trip (§4.2).
 */
export const MAX_TRIP_TRAVEL_MINUTES = 120;

/**
 * What has to be left of the day once the travelling is paid for.
 *
 * Less than this and the suggestion is a drive with a look round,
 * which is not what "genug für einen ganzen Tag" means.
 */
export const MIN_DAY_AT_TARGET_MINUTES = 240;

/**
 * How long a spot is assumed to take when asking whether a destination
 * could fill the day.
 *
 * A stated figure rather than a computed one: the pool at the
 * destination has not been built — building it would mean searching a
 * second city on the off-chance — so the count is all there is, and an
 * hour a spot is the planner's own middle (§4.1).
 */
export const ASSUMED_DWELL_MINUTES = 60;

/** One sight is not a day, however long the day is. */
export const MIN_SPOTS_FOR_A_DAY = 3;

export interface DayTripSuggestionRequest {
  planId: number;
  /** Which city of the trip. Defaults to the first. */
  legIndex?: number;
}

export interface DayTripTarget {
  name: string;
  /** "admin" when a named place holds it, "cluster" when it is a landscape. */
  source: string;
  /**
   * How this destination is referred to when accepting or refusing it:
   * the area's OSM reference, or its rounded position where no
   * boundary names it.
   */
  key: string;
  osmRef: string | null;
  lat: number;
  lon: number;
  /** Straight line from the quarters, in metres. */
  distanceM: number;
  /** One way, estimated at the leg's own mode (§12). */
  travelMinutes: number;
  /** What is left of the day once both ways are paid for. */
  dayAtTargetMinutes: number;
  /** How many spots worth a block stand there. */
  spotCount: number;
  /** A few of them by name, so the suggestion can argue for itself. */
  examples: string[];
}

export interface DayTripSuggestion {
  /** Which day it would be — the emptiest one of the leg. */
  dayIndex: number;
  target: DayTripTarget;
  /**
   * The whole thing in the traveller's words: why it comes up, what is
   * there, and what it costs.
   */
  sentence: string;
}

export interface DayTripSuggestionResponse {
  legIndex: number;
  /** True when this leg's own pool does not carry its days. */
  undersupplied: boolean;
  /** The measurement behind that, so the app can show the reasoning. */
  emptyMinutes: number;
  poolMinutes: number;
  uncoveredMinutes: number;
  dayMinutes: number;
  /** The one suggestion, or null when there is nothing to say. */
  suggestion: DayTripSuggestion | null;
  /** Why there is no suggestion, in the traveller's words, or null. */
  note: string | null;
}

export const dayTripSuggestion = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/day-trip", auth: true },
  async (req: DayTripSuggestionRequest): Promise<DayTripSuggestionResponse> => {
    const userId = requireUser();
    const { leg, legIndex } = await legOf(req.planId, userId, req.legIndex);
    const found = await suggestFor(leg);

    return {
      legIndex,
      undersupplied: found.measure.thin,
      emptyMinutes: found.measure.emptyMinutes,
      poolMinutes: found.measure.poolMinutes,
      uncoveredMinutes: found.measure.uncoveredMinutes,
      dayMinutes: found.measure.dayMinutes,
      suggestion: found.suggestion,
      note: found.note,
    };
  },
);

export interface AcceptDayTripRequest {
  planId: number;
  legIndex?: number;
  /** The destination as the suggestion named it. */
  key: string;
  /**
   * Which day it becomes. Omitted takes the one the suggestion named,
   * which is the emptiest of the leg.
   */
  dayIndex?: number;
}

/**
 * Turn the suggestion into a day trip (§4.6, §4.5).
 *
 * Nothing new happens here: it is the day anchor a person sets by
 * hand, with the same organiser rule and the same re-plan afterwards.
 * What is deliberate is that the destination is **looked up again**
 * rather than read out of the request. Where a day happens decides
 * which pool it is built from and how many minutes its blocks have,
 * and a request is not where that should come from — the same reason
 * taking a route in re-reads the route (§4.7).
 */
export const acceptDayTrip = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/day-trip", auth: true },
  async (req: AcceptDayTripRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const { leg, legIndex } = await legOf(req.planId, userId, req.legIndex);
    const found = await suggestFor(leg);

    const suggestion = found.suggestion;
    if (!suggestion || suggestion.target.key !== req.key) {
      throw APIError.failedPrecondition(
        "dieser Vorschlag gilt nicht mehr — der Plan hat sich inzwischen geändert",
      );
    }

    const dayIndex = req.dayIndex ?? suggestion.dayIndex;
    if (!leg.days.some((day) => day.dayIndex === dayIndex)) {
      throw APIError.notFound(`day ${dayIndex} not found in leg ${legIndex}`);
    }

    // The organiser rule, the validation and the re-plan all live in
    // the day-anchor call; going round it would mean keeping a second
    // copy of them in step (§4.5).
    return await setTripDayAnchor({
      planId: req.planId,
      legIndex,
      dayIndex,
      lat: suggestion.target.lat,
      lon: suggestion.target.lon,
      label: suggestion.target.name,
    });
  },
);

export interface DismissDayTripRequest {
  planId: number;
  legIndex?: number;
  /** The destination as the suggestion named it. */
  key: string;
  /** What it was called, so the answer can be read back later. */
  name?: string;
}

export interface DismissDayTripResponse {
  legIndex: number;
  key: string;
  dismissed: boolean;
}

/**
 * "No thanks" — remembered, not forgotten (§6.4, §7.1).
 *
 * Saying once that the city is an hour away is a service; saying it
 * every time the screen opens is nagging. The place stays reachable by
 * every other route into the planner: this is an answer about a
 * suggestion, not a ban on a city.
 */
export const dismissDayTrip = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/day-trip/dismiss",
    auth: true,
  },
  async (req: DismissDayTripRequest): Promise<DismissDayTripResponse> => {
    const userId = requireUser();
    const { leg, legIndex } = await legOf(req.planId, userId, req.legIndex);
    const key = req.key?.trim();
    if (!key) throw APIError.invalidArgument("key is required");

    // Said twice is said once.
    await db
      .insert(tripPlanDayTripDismissals)
      .values({
        leg_id: leg.id,
        target_key: key,
        name: req.name?.trim() || null,
        dismissed_by: userId,
      })
      .onConflictDoNothing();

    return { legIndex, key, dismissed: true };
  },
);

interface FoundSuggestion {
  measure: ThinPoolVerdict;
  suggestion: DayTripSuggestion | null;
  note: string | null;
}

/**
 * The three questions, asked once, for every caller that needs them.
 *
 * Shared deliberately: looking and accepting must never disagree about
 * what is being suggested, and the only way to guarantee that is for
 * both to work it out the same way.
 */
async function suggestFor(leg: StoredLeg): Promise<FoundSuggestion> {
  const measure = measureThinPool({
    days: leg.days.map((day) => ({
      dayIndex: day.dayIndex,
      hasOwnAnchor: day.anchor !== null,
      bufferReason: day.bufferReason,
      blocks: day.blocks,
    })),
    pool: leg.pool,
  });

  // The days carry: there is nothing to suggest anything *for*, and
  // this is where most legs stop (§4.6 — no outing as a gap filler).
  if (!measure.thin) return { measure, suggestion: null, note: noteForFullLeg(measure) };

  const region = await pickRegion(leg.anchor.lat, leg.anchor.lon);
  if (!region) {
    return { measure, suggestion: null, note: "Für diese Stadt ist noch keine Region importiert." };
  }

  const mode = leg.mode;
  // The ring starts outside the leg's own search, or the suggestion
  // would be a trip to where the travellers already are.
  const minRadiusM = leg.radiusM ?? searchRadiusFor(mode);
  const maxRadiusM = reachWithin(leg.anchor, mode, MAX_TRIP_TRAVEL_MINUTES);
  if (maxRadiusM <= minRadiusM) {
    return { measure, suggestion: null, note: noteForUnreachable(mode) };
  }

  let page;
  try {
    page = await getGeoClient().searchDayTargets(region.postgresDb, {
      center: { lat: leg.anchor.lat, lon: leg.anchor.lon },
      minRadiusM,
      maxRadiusM,
    });
  } catch {
    throw APIError.unavailable("die Region antwortet gerade nicht");
  }

  const refused = await dismissedKeys(leg.id);
  const target = pickTarget(page.targets, leg.anchor, mode, measure.dayMinutes, refused);
  if (!target) {
    return {
      measure,
      suggestion: null,
      note: "In erreichbarer Entfernung liegt nichts, was einen ganzen Tag trägt.",
    };
  }

  return {
    measure,
    suggestion: {
      dayIndex: measure.freeDays[0],
      target,
      sentence: sentenceFor(measure, target, leg),
    },
    note: null,
  };
}

/**
 * The strongest destination that would actually be a day.
 *
 * The list arrives ordered by how much stands there, so the first one
 * that survives the arithmetic is the one to offer — and if none
 * does, that is an answer too (§15.3).
 */
function pickTarget(
  targets: readonly GeoDayTarget[],
  anchor: Coordinate,
  mode: TransportMode,
  dayMinutes: number,
  refused: ReadonlySet<string>,
): DayTripTarget | null {
  for (const target of targets) {
    const key = keyFor(target);
    if (refused.has(key)) continue;
    const travelMinutes = travelLeg(anchor, target.at, mode).minutes;
    if (travelMinutes > MAX_TRIP_TRAVEL_MINUTES) continue;
    const dayAtTargetMinutes = dayMinutes - 2 * travelMinutes;
    if (dayAtTargetMinutes < MIN_DAY_AT_TARGET_MINUTES) continue;
    // Enough there to fill what is left of the day, and never fewer
    // than three: a single sight is not a day out, however short the
    // day.
    const needed = Math.max(
      MIN_SPOTS_FOR_A_DAY,
      Math.ceil(dayAtTargetMinutes / ASSUMED_DWELL_MINUTES),
    );
    if (target.spotCount < needed) continue;

    return {
      name: target.name,
      source: target.source,
      key,
      osmRef: target.osmRef,
      lat: target.at.lat,
      lon: target.at.lon,
      distanceM: Math.round(haversineMeters(anchor, target.at)),
      travelMinutes,
      dayAtTargetMinutes,
      spotCount: target.spotCount,
      examples: target.examples,
    };
  }
  return null;
}

/**
 * How a destination is named across calls.
 *
 * The area's own reference where a boundary named it; its rounded
 * position — about a hundred metres — where the destination is a
 * cluster of spots that no municipality is. Both survive a re-plan,
 * which is the point: a "no" said on Tuesday has to still hold on
 * Friday, after the days have been rebuilt twice.
 */
function keyFor(target: GeoDayTarget): string {
  if (target.osmRef) return target.osmRef;
  return `at:${target.at.lat.toFixed(3)},${target.at.lon.toFixed(3)}`;
}

async function dismissedKeys(legId: number): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ key: tripPlanDayTripDismissals.target_key })
    .from(tripPlanDayTripDismissals)
    .where(eq(tripPlanDayTripDismissals.leg_id, legId));
  return new Set(rows.map((row) => row.key));
}

/**
 * The sentence §4.6 asks for, and it names three things: why the
 * question comes up at all, what is there, and what it costs.
 */
function sentenceFor(
  measure: ThinPoolVerdict,
  target: DayTripTarget,
  leg: StoredLeg,
): string {
  const days = Math.max(1, Math.round(measure.uncoveredMinutes / Math.max(1, measure.dayMinutes)));
  const carried = countWord(Math.max(0, leg.days.length - days));
  const dayWord = days === 1 ? "einen Tag" : `${countWord(days)} Tage`;

  return `Vor Ort tragen die Vorschläge ${carried} eurer ${countWord(leg.days.length)} Tage. `
    + `In ${roughTime(target.travelMinutes)} Fahrt liegt ${target.name} — `
    + `dort sind ${target.spotCount} lohnende Orte erfasst, genug für ${dayWord}. `
    + `Einen Tag dorthin einplanen?`;
}

/** Why a leg that carries its days hears nothing. */
function noteForFullLeg(measure: ThinPoolVerdict): string | null {
  if (measure.reason !== "pool-has-more") return null;
  // Worth saying: the blocks *are* empty, and the reason is not a thin
  // pool, so a day trip would answer the wrong question.
  return measure.emptyMinutes > 0
    ? "Es ist noch Platz im Plan, aber auch noch genug im Vorrat dafür."
    : null;
}

function noteForUnreachable(mode: TransportMode): string {
  return mode === "foot" || mode === "bike"
    ? "Zu Fuß oder mit dem Rad liegt nichts in Tagesausflug-Nähe — "
      + "mit Auto oder Bahn als Fortbewegung sähe das anders aus."
    : "In erreichbarer Entfernung liegt nichts, was einen ganzen Tag trägt.";
}

/**
 * How far one gets in this many minutes, as the crow flies.
 *
 * Measured against the planner's own estimator rather than restated as
 * a speed: a probe leg due north of the anchor is scaled back to the
 * time wanted, so the ring and the per-target arithmetic can never
 * disagree about what "two hours away" means.
 */
function reachWithin(anchor: Coordinate, mode: TransportMode, minutes: number): number {
  const PROBE_M = 100_000;
  const probe = { lat: anchor.lat + PROBE_M / 111_132, lon: anchor.lon };
  const probeMinutes = travelLeg(anchor, probe, mode).minutes;
  if (probeMinutes <= 0) return 0;
  return Math.round((PROBE_M * minutes) / probeMinutes);
}

/** Small counts read as words; a number in a sentence reads as a form. */
function countWord(count: number): string {
  const words = ["null", "einen", "zwei", "drei", "vier", "fünf", "sechs", "sieben"];
  return words[count] ?? String(count);
}

/** "einer Stunde", "eineinhalb Stunden", "40 Minuten" — never "63 min". */
function roughTime(minutes: number): string {
  if (minutes < 75) return `${Math.round(minutes / 5) * 5} Minuten`;
  const halves = Math.round(minutes / 30) / 2;
  if (halves === 1) return "einer Stunde";
  if (halves === 1.5) return "eineinhalb Stunden";
  if (Number.isInteger(halves)) return `${countWord(halves)} Stunden`;
  return `${String(halves).replace(".", ",")} Stunden`;
}

async function legOf(
  planId: number,
  userId: number,
  legIndex: number | undefined,
): Promise<{ leg: StoredLeg; legIndex: number }> {
  const plan = await loadPlan(planId, userId);
  if (!plan) throw APIError.notFound("plan not found");
  const position = legIndex ?? 0;
  const leg = plan.legs.find((l) => l.position === position);
  if (!leg) throw APIError.notFound(`leg ${position} not found in this plan`);
  return { leg, legIndex: position };
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
