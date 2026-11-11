/**
 * What the travellers put on a day survives a re-plan (ideas plan,
 * stage 1).
 *
 * On a trip that starts with an empty list the planner never chooses a
 * spot, so every stop on a day is somebody's decision. A re-plan — a
 * changed setting, a new fixpoint, a stay made a day shorter — frames
 * the days again; it must not take those decisions with it. Each stop
 * goes back onto the day with the same index, into the block with the
 * same id where there still is one, and the day is walked again. A
 * stop whose day no longer exists goes back to the stay's ideas
 * instead of disappearing.
 *
 * Done and skipped stops are not carried: a re-plan of a stay somebody
 * has begun is refused before it gets here (`firstSettledStop`,
 * `refuseSettled`).
 */

import { dayWalkOfStored } from "./day-walk";
import { recomputeDay } from "./move";
import { excursionIdOf } from "./excursions";
import type { CreateDayInput, StoredLeg } from "./plan-store";
import type { CurrentBlock, CurrentStop } from "./redistribute";
import type { ScoredCandidate } from "./candidates";
import type { Coordinate, TransportMode } from "./travel";

/** An idea going back to the stay's list, with what it knew. */
export interface ReturnedIdea extends ScoredCandidate {
  origin: string;
  note?: string | null;
  sourceUrl?: string | null;
}

export function carryStops(
  before: Pick<StoredLeg, "days">,
  fresh: readonly CreateDayInput[],
  at: { anchor: Coordinate; mode: TransportMode },
): { days: CreateDayInput[]; back: ReturnedIdea[] } {
  const back: ReturnedIdea[] = [];
  const days = fresh.map((day) => ({ ...day, blocks: day.blocks.map((b) => ({ ...b, stops: [...b.stops] })) }));

  for (const old of before.days) {
    carryBreaks(old, days[old.dayIndex]);
    const stops = old.blocks.flatMap((block) =>
      block.stops
        .filter((stop) => stop.status === "planned")
        .map((stop) => ({ blockId: block.id, stop })));
    if (stops.length === 0) continue;

    const target = days[old.dayIndex];
    if (!target || target.blocks.length === 0) {
      for (const { stop } of stops) back.push(asIdea(stop));
      continue;
    }

    const already = new Set(target.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
    const blocks = target.blocks as unknown as CurrentBlock[];
    const fallback = blocks.find((b) => b.kind === "spots" && excursionIdOf(b.id) === null)
      ?? blocks.find((b) => b.kind === "spots") ?? blocks[0];
    for (const { blockId, stop } of stops) {
      if (already.has(stop.osmRef)) continue;
      const own = blocks.find((b) => b.id === blockId);
      // A spot of an excursion that is gone was chosen around a place
      // the day no longer goes to (`excursions.ts`): back to the ideas,
      // not into the day at the quarters.
      if (!own && excursionIdOf(blockId) !== null) {
        back.push(asIdea(stop));
        continue;
      }
      const block = own ?? fallback;
      block.stops.push(carried(stop));
      already.add(stop.osmRef);
    }
    recomputeDay(blocks, dayWalkOfStored(at.anchor, target), at.mode);
    target.detailed = true;
  }
  return { days, back };
}

/**
 * The breaks somebody put on a day (stage 4) go back onto it, into the
 * block with the same id or the day's first spots block.
 */
function carryBreaks(old: Pick<StoredLeg["days"][number], "breaks">, target: CreateDayInput | undefined): void {
  if (!target || !old.breaks || old.breaks.length === 0) return;
  const blocks = target.blocks as unknown as CurrentBlock[];
  const fallback = blocks.find((b) => b.kind === "spots");
  if (!fallback) return;
  target.breaks = old.breaks.map(({ id, label, minutes, blockId, position }) => ({
    id,
    label,
    minutes,
    blockId: blocks.some((b) => b.id === blockId && b.kind === "spots") ? blockId : fallback.id,
    position,
  }));
}

/** A stop as it goes onto the new day: the same decision, walked again. */
function carried(stop: CurrentStop): CurrentStop {
  return {
    osmRef: stop.osmRef,
    name: stop.name,
    localName: stop.localName ?? null,
    wikipediaUrl: stop.wikipediaUrl ?? null,
    facadeAzimuth: stop.facadeAzimuth ?? null,
    kind: stop.kind ?? null,
    extent: stop.extent,
    reasons: stop.reasons ?? [],
    lat: stop.lat,
    lon: stop.lon,
    category: stop.category,
    dwellMinutes: stop.dwellMinutes,
    score: stop.score,
    travelFromPrevious: stop.travelFromPrevious,
    status: "planned",
    pinned: stop.pinned,
    note: stop.note ?? null,
    sourceUrl: stop.sourceUrl ?? null,
    origin: stop.origin ?? "manual",
    priority: stop.priority,
    openingHours: stop.openingHours ?? null,
  };
}

function asIdea(stop: CurrentStop): ReturnedIdea {
  return {
    osmRef: stop.osmRef,
    name: stop.name,
    localName: stop.localName ?? null,
    wikipediaUrl: stop.wikipediaUrl ?? null,
    facadeAzimuth: stop.facadeAzimuth ?? null,
    kind: stop.kind ?? null,
    extent: stop.extent,
    lat: stop.lat,
    lon: stop.lon,
    category: stop.category,
    dwellMinutes: stop.dwellMinutes,
    score: stop.score,
    reasons: stop.reasons ?? [],
    // On a trip of ideas every stop is one somebody chose; as a search
    // row it would be deleted by the next re-plan.
    origin: "manual",
    note: stop.note ?? null,
    sourceUrl: stop.sourceUrl ?? null,
    priority: stop.priority,
    openingHours: stop.openingHours ?? null,
  };
}
