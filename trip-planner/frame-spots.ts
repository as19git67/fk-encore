/**
 * The stop a frame brings with it (§7.3).
 *
 * "Als Abendtermin einplanen" used to write an appointment beside the
 * blocks and leave the spot where it was — in the pool, or in an
 * afternoon block in the wrong light. The traveller then watched two
 * places for one outing, and the pool, not knowing, could plan the
 * same terrace twice. So a fixpoint may now be the frame of a block
 * (`fixpoints.ts`): it places the block at its hour, and this module
 * puts the spot into it.
 *
 * Three rules, all of them about the solver staying out of it:
 *
 *   - **The framed block is filled by its spot and nothing else.** The
 *     solver sees it with no budget, so a block at 20:10 is not filled
 *     with museums that closed at six.
 *   - **The spot is reserved before any day is solved.** Otherwise the
 *     Tuesday afternoon takes it first and the Thursday evening finds
 *     it gone — or plans it a second time.
 *   - **The stop is pinned.** A redistribution moves the solver's
 *     choices; it does not move what somebody accepted at an hour.
 *
 * Pure: blocks and candidates in, blocks out.
 */

import type { PlannedBlockShape } from "./blocks";
import type { DayWalk } from "./day-walk";
import type { Fixpoint } from "./fixpoints";
import { recomputeDay } from "./move";
import type { CurrentBlock, CurrentStop } from "./redistribute";
import type { Candidate, PlannedBlock, PlannedStop } from "./solver";
import type { TransportMode } from "./travel";

/** One block's frame, as the spot placement needs it. */
export interface FramedSpot {
  blockId: string;
  osmRef: string;
  /** The window's length — how long the stop keeps the group there. */
  dwellMinutes: number;
}

/** The frames among a day's fixpoints: appointments bound to a block and a spot. */
export function framedSpotsOf(
  fixpoints: readonly Pick<Fixpoint, "kind" | "blockId" | "spotRef" | "durationMinutes">[],
): FramedSpot[] {
  const out: FramedSpot[] = [];
  for (const fix of fixpoints) {
    if ((fix.kind ?? "appointment") !== "appointment") continue;
    if (!fix.blockId || !fix.spotRef) continue;
    out.push({
      blockId: fix.blockId,
      osmRef: fix.spotRef,
      dwellMinutes: Math.max(1, Math.round(fix.durationMinutes ?? 0)),
    });
  }
  return out;
}

/** The candidates without the ones a frame has already spoken for. */
export function withoutFramed<T extends { osmRef: string }>(
  candidates: readonly T[],
  framed: readonly FramedSpot[],
): T[] {
  if (framed.length === 0) return [...candidates];
  const taken = new Set(framed.map((f) => f.osmRef));
  return candidates.filter((c) => !taken.has(c.osmRef));
}

/**
 * The shapes as the solver should see them: a framed block has no room
 * for anything but its spot, so it gets none.
 */
export function budgetsForSolver(
  shapes: readonly PlannedBlockShape[],
  framed: readonly FramedSpot[],
): PlannedBlockShape[] {
  if (framed.length === 0) return [...shapes];
  const bound = new Set(framed.map((f) => f.blockId));
  return shapes.map((shape) => (bound.has(shape.id) ? { ...shape, budgetMinutes: 0 } : shape));
}

export interface FramedPlacement {
  blocks: PlannedBlock[];
  /** Frames whose spot is nowhere to be found — nothing was placed for them. */
  missing: FramedSpot[];
}

/**
 * Put each frame's spot into its block and rewalk the day.
 *
 * `budgets` are the true budgets — the frame's own — which the solver
 * was shown as zero; they are restored here so the stored block says
 * how long the evening is rather than that it has no room.
 *
 * A frame whose spot is not among the candidates places nothing and is
 * reported: the spot may have been hidden since, and a block framed
 * for a place the trip turned down is the caller's to unframe.
 */
export function placeFramed(
  solved: readonly PlannedBlock[],
  framed: readonly FramedSpot[],
  candidates: readonly Candidate[],
  budgets: readonly Pick<PlannedBlockShape, "id" | "budgetMinutes">[],
  walk: DayWalk,
  mode: TransportMode,
): FramedPlacement {
  if (framed.length === 0) return { blocks: [...solved], missing: [] };

  const byRef = new Map(candidates.map((c) => [c.osmRef, c]));
  const budgetOf = new Map(budgets.map((b) => [b.id, b.budgetMinutes]));
  const missing: FramedSpot[] = [];

  const current: CurrentBlock[] = solved.map((block) => ({
    ...block,
    stops: block.stops.map(asCurrent),
  }));

  for (const frame of framed) {
    const block = current.find((b) => b.id === frame.blockId);
    const candidate = byRef.get(frame.osmRef);
    if (!block || !candidate) {
      missing.push(frame);
      continue;
    }
    // In front of anything the solver may have left there — it has no
    // budget, so nothing — and pinned: this is what was accepted.
    block.stops.unshift({ ...stopFor(candidate, frame.dwellMinutes), status: "planned", pinned: true });
    block.budgetMinutes = budgetOf.get(block.id) ?? block.budgetMinutes;
  }

  // The walks either side of the new stop, and the way home off the
  // last block that holds one: the same rewalk every move gets, so the
  // evening and the rest of the day describe one route.
  recomputeDay(current, walk, mode);

  return {
    blocks: current.map((block) => ({
      ...block,
      stops: block.stops.map(asPlanned),
    })),
    missing,
  };
}

function stopFor(candidate: Candidate, dwellMinutes: number): PlannedStop {
  return {
    osmRef: candidate.osmRef,
    name: candidate.name,
    localName: candidate.localName ?? null,
    wikipediaUrl: candidate.wikipediaUrl ?? null,
    facadeAzimuth: candidate.facadeAzimuth ?? null,
    kind: candidate.kind ?? null,
    extent: candidate.extent ?? null,
    photoStop: candidate.photoStop,
    origin: candidate.origin,
    reasons: candidate.reasons ?? [],
    lat: candidate.lat,
    lon: candidate.lon,
    category: candidate.category,
    // The window, not the category's usual stay: the group is there
    // for as long as the light is.
    dwellMinutes,
    score: candidate.score,
    // Overwritten by the rewalk below; a placeholder, not an estimate.
    travelFromPrevious: { minutes: 0, distanceM: 0, travelClass: "short_walk" },
    pinned: true,
  };
}

function asCurrent(stop: PlannedStop): CurrentStop {
  return { ...stop, status: "planned", pinned: stop.pinned ?? false };
}

function asPlanned(stop: CurrentStop): PlannedStop {
  const { status: _status, ...rest } = stop;
  return rest;
}
