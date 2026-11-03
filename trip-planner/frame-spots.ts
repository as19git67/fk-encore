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
 * A booked visit is the same idea without a block of its own: the
 * ticket for the tower at 14:00 is an ordinary appointment that names
 * its spot (`spotRef` without `blockId`). It cuts the blocks around it
 * like any appointment, and the block that follows it — or, at the end
 * of the day, the one before — opens up to hold it: the way there and
 * the visit become part of that block, the spot its pinned first (or
 * last) stop. The spot is reserved on every day exactly like a frame's,
 * so the planner never puts it into a second block on its own.
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
  /**
   * For a booked visit: the minutes of the host block that belong to
   * the visit (the way there and the visit itself), which the solver
   * must not fill. Absent for a frame, whose block is its spot's alone.
   */
  reserveMinutes?: number;
  /**
   * Where in the host block the stop goes. Absent means at the front —
   * a frame, or a visit that opens the block after it; "end" for a
   * visit at the end of the day, hosted by the block before it.
   */
  at?: "end";
}

type FixpointBinding = Pick<Fixpoint, "kind" | "blockId" | "spotRef" | "durationMinutes"> &
  Partial<Pick<Fixpoint, "startMinutes" | "travelMinutes">>;

/** A block as far as hosting a visit needs it: where it sits on the clock. */
export interface ClockedBlock {
  id: string;
  startMinutes?: number | null;
  budgetMinutes: number;
}

/** True for an appointment that names its spot but frames no block: a booked visit. */
export function isVisit(fix: Pick<Fixpoint, "kind" | "blockId" | "spotRef">): boolean {
  return (fix.kind ?? "appointment") === "appointment" && !!fix.spotRef && !fix.blockId;
}

/**
 * Every spot a fixpoint has spoken for — frame or booked visit. These
 * are the ones no solver may plan on its own, on any day of the leg.
 */
export function reservedSpotRefs(
  fixpoints: readonly Pick<Fixpoint, "kind" | "spotRef" | "blockId">[],
): Set<string> {
  const out = new Set<string>();
  for (const fix of fixpoints) {
    if ((fix.kind ?? "appointment") !== "appointment" || !fix.spotRef) continue;
    out.add(fix.spotRef);
  }
  return out;
}

/**
 * The frames among a day's fixpoints: appointments bound to a block and
 * a spot, and booked visits with the block that hosts them.
 *
 * A visit needs the day's blocks to find its host; without them (or
 * on a day with no block left) it places nothing, and its spot stays
 * reserved all the same — a ticket is not a reason to plan the tower
 * twice.
 */
export function framedSpotsOf(
  fixpoints: readonly FixpointBinding[],
  blocks: readonly ClockedBlock[] = [],
): FramedSpot[] {
  const out: FramedSpot[] = [];
  for (const fix of fixpoints) {
    if ((fix.kind ?? "appointment") !== "appointment") continue;
    if (fix.blockId && fix.spotRef) {
      out.push({
        blockId: fix.blockId,
        osmRef: fix.spotRef,
        dwellMinutes: Math.max(1, Math.round(fix.durationMinutes ?? 0)),
      });
      continue;
    }
    if (!isVisit(fix) || fix.startMinutes === undefined) continue;
    const host = hostOf(blocks, fix.startMinutes);
    if (!host) continue;
    const duration = Math.max(0, Math.round(fix.durationMinutes ?? 0));
    out.push({
      blockId: host.block.id,
      osmRef: fix.spotRef!,
      dwellMinutes: Math.max(1, duration),
      reserveMinutes: Math.max(0, Math.round(fix.travelMinutes ?? 0)) + duration,
      ...(host.at === "end" ? { at: "end" as const } : {}),
    });
  }
  return out;
}

/**
 * The block a visit at this hour belongs to.
 *
 * A block whose span holds the hour is the host — that is what a block
 * looks like after `hostVisits` opened it. Otherwise the first block
 * that begins after it (the visit opens that block), and at the end of
 * the day the last one before it (the visit closes that block).
 */
export function hostOf(
  blocks: readonly ClockedBlock[],
  startMinutes: number,
): { block: ClockedBlock; at: "start" | "end" } | null {
  const clocked = blocks
    .filter((b): b is ClockedBlock & { startMinutes: number } => typeof b.startMinutes === "number")
    .sort((a, b) => a.startMinutes - b.startMinutes);
  const holding = clocked.find(
    (b) => b.startMinutes <= startMinutes && startMinutes < b.startMinutes + b.budgetMinutes,
  );
  if (holding) {
    // Front or back by which half of the block the visit sits in: a
    // block the visit opened begins with it, one it closed ends with it.
    const at = startMinutes - holding.startMinutes <= holding.budgetMinutes / 2 ? "start" : "end";
    return { block: holding, at };
  }
  const after = clocked.find((b) => b.startMinutes >= startMinutes);
  if (after) return { block: after, at: "start" };
  const before = clocked[clocked.length - 1];
  return before ? { block: before, at: "end" } : null;
}

/**
 * Open the blocks that host a booked visit, so the visit happens inside
 * one of them rather than in a gap between two (§4.4).
 *
 * The scheduler cut the day around the appointment like any other: the
 * block before it ends at its guard, the one after it starts once it is
 * over. Here the block after it moves its start forward to when the way
 * there begins, and grows by as much — the walk to the tower and the
 * tower are now that block's first minutes. With no block after it, the
 * last block before it is extended to the visit's end instead.
 *
 * Run once, on freshly scheduled blocks; a block that already holds
 * the hour is left alone.
 */
export function hostVisits<T extends ClockedBlock>(
  blocks: readonly T[],
  fixpoints: readonly Pick<Fixpoint, "kind" | "blockId" | "spotRef" | "startMinutes" | "durationMinutes" | "travelMinutes">[],
): T[] {
  const out = blocks.map((b) => ({ ...b }));
  const visits = fixpoints.filter(isVisit).sort((a, b) => a.startMinutes - b.startMinutes);
  for (const visit of visits) {
    const host = hostOf(out, visit.startMinutes);
    if (!host) continue;
    const block = out.find((b) => b.id === host.block.id)!;
    const start = block.startMinutes as number;
    const end = start + block.budgetMinutes;
    if (start <= visit.startMinutes && visit.startMinutes < end) continue;
    const travel = Math.max(0, Math.round(visit.travelMinutes ?? 0));
    const duration = Math.max(0, Math.round(visit.durationMinutes ?? 0));
    if (host.at === "start") {
      // Not into the block before: it ends at the guard, and the buffer
      // in between stays the buffer.
      const previousEnd = Math.max(
        0,
        ...out
          .filter((b) => typeof b.startMinutes === "number" && (b.startMinutes as number) < start)
          .map((b) => (b.startMinutes as number) + b.budgetMinutes),
      );
      const opens = Math.max(previousEnd, visit.startMinutes - travel);
      if (opens < start) {
        block.budgetMinutes += start - opens;
        block.startMinutes = opens;
      }
    } else {
      // The block before was cut at the guard; the buffer is spent
      // waiting at the door, the visit inside, and the block ends when
      // the visit does.
      const closes = Math.max(end, visit.startMinutes + duration);
      block.budgetMinutes += closes - end;
    }
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
  // A frame takes its whole block; a visit only the minutes it holds.
  const reserve = new Map<string, number>();
  for (const f of framed) {
    const minutes = f.reserveMinutes ?? Number.POSITIVE_INFINITY;
    reserve.set(f.blockId, (reserve.get(f.blockId) ?? 0) + minutes);
  }
  return shapes.map((shape) => {
    const taken = reserve.get(shape.id);
    if (taken === undefined) return shape;
    return { ...shape, budgetMinutes: Math.max(0, shape.budgetMinutes - taken) };
  });
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
    // In front of anything the solver may have left there — for a
    // frame it has no budget, so nothing — and pinned: this is what was
    // accepted. A visit at the end of the day goes behind the rest.
    const stop = { ...stopFor(candidate, frame.dwellMinutes), status: "planned" as const, pinned: true };
    if (frame.at === "end") block.stops.push(stop);
    else block.stops.unshift(stop);
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
    extent: candidate.extent,
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
