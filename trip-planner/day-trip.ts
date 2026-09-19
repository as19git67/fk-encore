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
 * from the collection (§20.2) use: **suggest, do not plan.** This
 * endpoint writes nothing at all. Accepting is a second call, the one
 * that sets the day's anchor (§4.5) — which is a thing a person does.
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
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient, type GeoDayTarget } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { loadPlan, type StoredLeg } from "./plan-store";
import { measureThinPool, type ThinPoolVerdict } from "./thin-pool";
import { searchRadiusFor } from "./search-reach";
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
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legIndex = req.legIndex ?? 0;
    const leg = plan.legs.find((l) => l.position === legIndex);
    if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

    const measure = measureThinPool({
      days: leg.days.map((day) => ({
        dayIndex: day.dayIndex,
        hasOwnAnchor: day.anchor !== null,
        bufferReason: day.bufferReason,
        blocks: day.blocks,
      })),
      pool: leg.pool,
    });

    const answer = (
      suggestion: DayTripSuggestion | null,
      note: string | null,
    ): DayTripSuggestionResponse => ({
      legIndex,
      undersupplied: measure.thin,
      emptyMinutes: measure.emptyMinutes,
      poolMinutes: measure.poolMinutes,
      uncoveredMinutes: measure.uncoveredMinutes,
      dayMinutes: measure.dayMinutes,
      suggestion,
      note,
    });

    // The days carry: there is nothing to suggest anything *for*, and
    // this is where most legs stop (§4.6 — no outing as a gap filler).
    if (!measure.thin) return answer(null, noteForFullLeg(measure));

    const region = await pickRegion(leg.anchor.lat, leg.anchor.lon);
    if (!region) {
      return answer(null, "Für diese Stadt ist noch keine Region importiert.");
    }

    const mode = leg.mode;
    // The ring starts outside the leg's own search, or the suggestion
    // would be a trip to where the travellers already are.
    const minRadiusM = leg.radiusM ?? searchRadiusFor(mode);
    const maxRadiusM = reachWithin(leg.anchor, mode, MAX_TRIP_TRAVEL_MINUTES);
    if (maxRadiusM <= minRadiusM) {
      return answer(null, noteForUnreachable(mode));
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

    const dayIndex = measure.freeDays[0];
    const target = pickTarget(page.targets, leg.anchor, mode, measure.dayMinutes);
    if (!target) {
      return answer(null, "In erreichbarer Entfernung liegt nichts, was einen ganzen Tag trägt.");
    }

    return answer(
      { dayIndex, target, sentence: sentenceFor(measure, target, leg) },
      null,
    );
  },
);

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
): DayTripTarget | null {
  for (const target of targets) {
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
 * The sentence §4.6 asks for, and it names three things: why the
 * question comes up at all, what is there, and what it costs.
 */
function sentenceFor(
  measure: ThinPoolVerdict,
  target: DayTripTarget,
  leg: StoredLeg,
): string {
  const here = leg.title?.trim() || leg.anchorLabel?.trim() || "vor Ort";
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
  switch (measure.reason) {
    case "too-few-days":
      return null;
    case "days-are-full":
      return null;
    case "pool-has-more":
      // Worth saying: the blocks *are* empty, and the reason is not a
      // thin pool, so a day trip would answer the wrong question.
      return measure.emptyMinutes > 0
        ? "Es ist noch Platz im Plan, aber auch noch genug im Vorrat dafür."
        : null;
    default:
      return null;
  }
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

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
