/**
 * A day trip inside a day: Seestadt from 10:15 to 15:30, Bergdorf
 * before and after (Anton, 10.11.: "wie ein verschachtelter Aufenthalt
 * mit begrenzter Zeitspanne"; 11.11.: several on one day, no limit).
 *
 * The whole-day day trip (`day-anchor.ts`) moves the entire day to the
 * destination. That is right for a day in a big city and wrong for half
 * a day in Hafenstadt: the morning in the village and the evening back at
 * the quarters are part of the same day, around the same bed.
 *
 * So an excursion is a **block** of the day. The day's spots block is
 * cut where the excursion takes the group away — from the hour they
 * leave the quarters to the hour they are back — and the excursion
 * stands in the gap as a spots block of its own, planned around its
 * destination, from the hour they arrive there to the hour they start
 * back. Every stop then knows where it belongs by the block it is in,
 * and everything that orders or times a day walks blocks already.
 *
 * Only on a trip of ideas: the old solver plans whole days out of one
 * pool and has no notion of half a day somewhere else.
 *
 * Pure apart from the types: the clock in, blocks out.
 */

import { MIN_VIABLE_BLOCK_MINUTES } from "./fixpoints";
import { dayTripMode, travelLeg, type Coordinate, type TransportMode } from "./travel";

/** A day trip with a time window, as stored beside the day (migration 0311). */
export interface Excursion {
  id: string;
  lat: number;
  lon: number;
  /** "Seestadt". */
  label: string | null;
  /** How far to look around it; null falls back to the walking default. */
  radiusM: number | null;
  /** When the group leaves the quarters, minutes past midnight. */
  departMinutes: number;
  /** When they start back from the destination. */
  returnMinutes: number;
}

/** An excursion as read, with what the way there costs. */
export interface StoredExcursion extends Excursion {
  /** One way, in minutes, from the quarters with the stay's mode. Derived, never stored. */
  travelMinutes: number;
}

/** The id of the block an excursion is planned in. */
export function excursionBlockId(excursionId: string): string {
  return `excursion:${excursionId}`;
}

/** The excursion a block belongs to, or null for the day at the quarters. */
export function excursionIdOf(blockId: string): string | null {
  return blockId.startsWith("excursion:") ? blockId.slice("excursion:".length) : null;
}

/** "Ausflug nach Seestadt". */
export function excursionLabel(excursion: Pick<Excursion, "label">): string {
  return excursion.label ? `Ausflug nach ${excursion.label}` : "Ausflug";
}

/** One way from the quarters to the destination, never on foot (`dayTripMode`). */
export function excursionTravel(quarters: Coordinate, excursion: Pick<Excursion, "lat" | "lon">, stayMode: TransportMode): number {
  return travelLeg(quarters, { lat: excursion.lat, lon: excursion.lon }, dayTripMode(stayMode)).minutes;
}

/** The hours the group is away: from leaving the quarters to being back. */
export function awaySpan(excursion: Excursion, travelMinutes: number): { from: number; to: number } {
  return { from: excursion.departMinutes, to: excursion.returnMinutes + travelMinutes };
}

/** The hours the group is at the destination. */
export function thereSpan(excursion: Excursion, travelMinutes: number): { from: number; to: number } {
  return { from: excursion.departMinutes + travelMinutes, to: excursion.returnMinutes };
}

/**
 * Why a set of excursions cannot stand on one day, or null when it can.
 * Checked when one is added or moved, so the day never holds two
 * places at once or a window with no time in it.
 */
export function excursionProblem(
  excursions: readonly Excursion[],
  travel: (excursion: Excursion) => number,
): string | null {
  const spans = excursions
    .map((e) => ({ e, away: awaySpan(e, travel(e)), there: thereSpan(e, travel(e)) }))
    .sort((a, b) => a.away.from - b.away.from);
  for (const { e, there } of spans) {
    if (e.returnMinutes <= e.departMinutes) return "die Rückfahrt muss nach der Abfahrt liegen";
    if (there.to - there.from < MIN_VIABLE_BLOCK_MINUTES) {
      return `${excursionLabel(e)}: nach der Fahrt bleibt dort keine Zeit`;
    }
    if (there.to + travel(e) > 24 * 60) return `${excursionLabel(e)}: die Rückkehr liegt nach Mitternacht`;
  }
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].away.from < spans[i - 1].away.to) {
      return `${excursionLabel(spans[i].e)} beginnt, bevor ihr von ${spans[i - 1].e.label ?? "dem anderen Ausflug"} zurück seid`;
    }
  }
  return null;
}

interface FrameBlock {
  id: string;
  label: string;
  kind: string;
  startMinutes?: number | null;
  budgetMinutes: number;
}

/**
 * The day's blocks with its excursions cut in.
 *
 * Each spots block at the quarters loses the hours the group is away.
 * What is left before an excursion keeps the block's id, so the stops
 * already there stay; a piece after it is a block of its own
 * (`<id>@<excursion>`). A piece too short to hold anything is dropped,
 * like any block a fixpoint leaves with no room. The excursion's block
 * holds the hours at the destination.
 */
export function withExcursions<T extends FrameBlock>(
  blocks: readonly T[],
  excursions: readonly Excursion[],
  travel: (excursion: Excursion) => number,
): T[] {
  if (excursions.length === 0) return [...blocks];
  const sorted = [...excursions].sort((a, b) => a.departMinutes - b.departMinutes);
  const template = blocks.find((b) => b.kind === "spots");
  if (!template) return [...blocks];

  const out: T[] = [];
  for (const block of blocks) {
    if (block.kind !== "spots" || typeof block.startMinutes !== "number") {
      out.push(block);
      continue;
    }
    let pieceStart = block.startMinutes;
    const end = block.startMinutes + block.budgetMinutes;
    let pieceId = block.id;
    for (const excursion of sorted) {
      const away = awaySpan(excursion, travel(excursion));
      if (away.to <= pieceStart || away.from >= end) continue;
      if (away.from - pieceStart >= MIN_VIABLE_BLOCK_MINUTES) {
        out.push({ ...block, id: pieceId, startMinutes: pieceStart, budgetMinutes: away.from - pieceStart });
      }
      pieceStart = Math.max(pieceStart, away.to);
      pieceId = `${block.id}@${excursion.id}`;
    }
    if (end - pieceStart >= MIN_VIABLE_BLOCK_MINUTES) {
      out.push({ ...block, id: pieceId, startMinutes: pieceStart, budgetMinutes: end - pieceStart });
    }
  }
  for (const excursion of sorted) {
    const there = thereSpan(excursion, travel(excursion));
    out.push({
      ...template,
      id: excursionBlockId(excursion.id),
      label: excursionLabel(excursion),
      kind: "spots",
      startMinutes: there.from,
      budgetMinutes: Math.max(0, there.to - there.from),
    });
  }
  return out.sort((a, b) => (a.startMinutes ?? 0) - (b.startMinutes ?? 0));
}

/**
 * Where a block's line begins, given where the walk stood after the
 * block before it: at the destination for an excursion, back at the
 * quarters for the first block after one, otherwise where the last
 * spot was left.
 */
export function blockStart(
  blockId: string,
  previousBlockId: string | null,
  position: Coordinate,
  quarters: Coordinate,
  places: Readonly<Record<string, Coordinate>> | undefined,
): Coordinate {
  const place = places?.[blockId];
  if (place) return place;
  if (previousBlockId !== null && places?.[previousBlockId]) return quarters;
  return position;
}

/** Each excursion's block and the place it is planned around. */
export function excursionPlaces(excursions: readonly Pick<Excursion, "id" | "lat" | "lon">[] | undefined): Record<string, Coordinate> {
  return Object.fromEntries((excursions ?? []).map((e) => [excursionBlockId(e.id), { lat: e.lat, lon: e.lon }]));
}
