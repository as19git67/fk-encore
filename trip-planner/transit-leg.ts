/**
 * The journey between two legs, as a leg of its own (§22.7).
 *
 * Until now the way from one base to the next had no home: its
 * departure was a fixpoint on the last day of one leg, its arrival the
 * late start of the next, and a stop on the way belonged to neither. A
 * transit leg is the journey itself. It starts at the previous leg's
 * base at a given time on a given day and ends at the next leg's base
 * at a given time on a given day — two hours or three days, whatever
 * the journey takes.
 *
 * Built out of what the planner already understands, so nothing
 * downstream needs to learn a new kind of day:
 *
 *   - **Where the day begins and ends** are fixpoints: an appointment
 *     "Abfahrt" at the origin on the first day, a departure "Ankunft"
 *     at the destination on the last (`day-ends.ts` reads both, so
 *     every rewalk — a move, a hide, a redistribution — goes from the
 *     one to the other).
 *   - **A journey within a day by car, bike or on foot is planned**:
 *     one block "Unterwegs" over the whole window, its pool the
 *     corridor between the two bases, and the drive from start to
 *     destination as its base load. The solver charges the way on to
 *     the destination to the block, so a stop only goes in when its
 *     detour still fits the window.
 *   - **Anything else is a frame without stops**: by train or plane
 *     there is nothing to stop at, and a journey over several days has
 *     no known place to spend the night. The days say where the group
 *     is and plan nothing into it.
 */

import { pickRegion } from "../osm-admin/region-router";
import type { PlannedBlockShape } from "./blocks";
import type { ScoredCandidate } from "./candidates";
import { corridorCandidates, regionsCovering } from "./corridor";
import { parseMinutes } from "./fixpoints";
import type { CreateDayInput, CreateFixpointInput, CreateLegInput, LegOrigin } from "./plan-store";
import { requestRegionFor, type RequestedRegion } from "./region-request";
import { solveDay } from "./solver";
import { travelLeg, type Coordinate, type TransportMode } from "./travel";
import { applyVotes, type Tally } from "./votes";

/** The block a planned journey is one of — and the only one. */
export const TRANSIT_BLOCK_ID = "transit";

/** How far a stop may take the group off the direct line, there and back. */
const DETOUR_BUDGET_M: Readonly<Record<TransportMode, number>> = {
  car: 30_000,
  bike: 4_000,
  foot: 1_500,
  transit: 0,
  ship: 0,
};

/** What is worth planning: a journey you can stop on the way of. */
const PLANNABLE: ReadonlySet<TransportMode> = new Set(["car", "bike", "foot"]);

export interface TransitFrameInput {
  origin: LegOrigin;
  destination: Coordinate & { label?: string | null };
  /** Days the journey touches, from the departure's to the arrival's. */
  dayCount: number;
  departMinutes: number;
  endMinutes: number;
  mode: TransportMode;
}

export interface TransitDayFrame {
  dayIndex: number;
  /** Minutes past midnight the window opens and closes on this day. */
  fromMinutes: number;
  toMinutes: number;
  fixpoints: CreateFixpointInput[];
  /** True for the one day a stop can be planned on. */
  plannable: boolean;
  /** Why a day is left without stops, for the screen to say. */
  reason: string | null;
}

/**
 * The days of a journey and what each one holds — pure, so the frame
 * can be tested without a map.
 */
export function transitFrame(input: TransitFrameInput): TransitDayFrame[] {
  if (input.dayCount < 1) throw new Error("a journey takes at least one day");
  if (input.dayCount === 1 && input.endMinutes <= input.departMinutes) {
    throw new Error("a journey within a day has to arrive after it sets off");
  }
  const originLabel = input.origin.label ?? "Start";
  const destinationLabel = input.destination.label ?? "Ziel";
  const plannableMode = PLANNABLE.has(input.mode);

  return Array.from({ length: input.dayCount }, (_, dayIndex) => {
    const first = dayIndex === 0;
    const last = dayIndex === input.dayCount - 1;
    const fixpoints: CreateFixpointInput[] = [];
    if (first) {
      fixpoints.push({
        id: "transit-depart",
        label: `Abfahrt ${originLabel}`,
        kind: "appointment",
        startMinutes: input.departMinutes,
        durationMinutes: 0,
        lat: input.origin.lat,
        lon: input.origin.lon,
      });
    }
    if (last) {
      fixpoints.push({
        id: "transit-arrive",
        label: `Ankunft ${destinationLabel}`,
        kind: "departure",
        startMinutes: input.endMinutes,
        durationMinutes: 0,
        travelMinutes: 0,
        bufferMinutes: 5,
        lat: input.destination.lat,
        lon: input.destination.lon,
      });
    }
    const plannable = input.dayCount === 1 && plannableMode;
    return {
      dayIndex,
      fromMinutes: first ? input.departMinutes : 0,
      toMinutes: last ? input.endMinutes : 24 * 60,
      fixpoints,
      plannable,
      reason: plannable
        ? null
        : !plannableMode
          ? input.mode === "transit" ? "Unterwegs mit Bahn oder Bus"
            // A sea day (§21.3): the ship is where the day happens, and
            // the deck programme goes in as fixpoints.
            : input.mode === "ship" ? "An Bord" : "Unterwegs"
          : "Unterwegs über mehrere Tage — für eine Übernachtung unterwegs eine eigene Etappe anlegen",
    };
  });
}

export interface TransitLegRequest {
  title?: string;
  origin: LegOrigin;
  destination: Coordinate & { label?: string | null };
  startDate: string | null;
  dayCount: number;
  departMinutes: number;
  endMinutes: number;
  mode: TransportMode;
}

export interface TransitPlanOptions {
  categories?: string[];
  interests?: string[];
  dwellMinutes?: Record<string, number>;
  hidden?: ReadonlySet<string>;
  votes?: Tally;
}

/**
 * Plan a journey: its frame, and — when it is one you can stop on — its
 * one block filled from the corridor.
 */
export async function planTransitLeg(
  req: TransitLegRequest,
  opts: TransitPlanOptions,
): Promise<{ leg: CreateLegInput; pending: RequestedRegion | null }> {
  const frames = transitFrame({
    origin: req.origin,
    destination: req.destination,
    dayCount: req.dayCount,
    departMinutes: req.departMinutes,
    endMinutes: req.endMinutes,
    mode: req.mode,
  });

  // The leg's region is the destination's: that is where it ends, and
  // what a region-bound lookup on the leg should find. The pool comes
  // from every region either end is in.
  const region = await pickRegion(req.destination.lat, req.destination.lon)
    ?? await pickRegion(req.origin.lat, req.origin.lon);
  const pending = region ? null : await requestRegionFor(req.destination);

  const needsPool = frames.some((f) => f.plannable);
  let pool: ScoredCandidate[] = [];
  if (needsPool) {
    const regions = await regionsCovering(req.origin, req.destination, DETOUR_BUDGET_M[req.mode]);
    if (regions.length > 0) {
      const found = await corridorCandidates(regions, req.origin, req.destination, {
        detourBudgetM: DETOUR_BUDGET_M[req.mode],
        categories: opts.categories,
        interests: opts.interests,
        dwellMinutes: opts.dwellMinutes,
        requireProminence: true,
      });
      pool = found
        .filter((c) => !opts.hidden?.has(c.osmRef))
        .map(({ detourM: _detour, ...candidate }) => candidate);
      if (opts.votes) pool = applyVotes(pool, opts.votes);
    }
  }

  const direct = travelLeg(req.origin, req.destination, req.mode);
  let remaining = pool;
  const days: CreateDayInput[] = frames.map((frame) => {
    const budget = Math.max(0, frame.toMinutes - frame.fromMinutes);
    const shape: PlannedBlockShape = {
      id: TRANSIT_BLOCK_ID,
      label: "Unterwegs",
      kind: "spots",
      baseBudgetMinutes: budget,
      budgetMinutes: budget,
    };
    if (!frame.plannable) {
      return {
        blocks: [{ id: shape.id, label: shape.label, kind: shape.kind, budgetMinutes: budget,
                   usedMinutes: 0, stops: [], startMinutes: frame.fromMinutes }],
        fixpoints: frame.fixpoints,
        detailed: false,
        bufferReason: frame.reason,
      };
    }
    const solved = solveDay({
      anchor: req.destination,
      start: req.origin,
      end: req.destination,
      blocks: [shape],
      candidates: remaining,
      // One hop may be the whole drive: from the last stop on to the
      // destination is as long as the journey is, and a limit meant for
      // hops within a city would refuse every stop that is not at the
      // very end.
      maxWalkMinutes: Math.max(direct.minutes, 1) + budget,
      mode: req.mode,
    });
    remaining = solved.unplaced as ScoredCandidate[];
    return {
      blocks: solved.blocks.map((b) => ({
        ...b,
        startMinutes: frame.fromMinutes,
        stops: b.stops.map((s) => ({ ...s, status: "planned" as const, pinned: false })),
      })),
      fixpoints: frame.fixpoints,
      detailed: true,
      bufferReason: null,
    };
  });

  return {
    leg: {
      title: req.title,
      kind: "transit",
      origin: req.origin,
      departMinutes: req.departMinutes,
      endMinutes: req.endMinutes,
      anchor: { lat: req.destination.lat, lon: req.destination.lon },
      anchorLabel: req.destination.label ?? null,
      mode: req.mode,
      regionDb: region?.postgresDb ?? pending?.postgresDb ?? "",
      awaitingRegion: region === null,
      startDate: req.startDate,
      days,
      pool: remaining,
    },
    pending,
  };
}

/** "HH:MM" to minutes past midnight, or null. */
export function minutesOf(text: string | undefined): number | null {
  if (typeof text !== "string") return null;
  return parseMinutes(text);
}
