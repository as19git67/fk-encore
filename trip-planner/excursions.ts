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
 * Excursions can follow each other without the way back in between
 * (Anton, 13.11.: one town, straight on to the next, then home).
 * Such an excursion names the one before it in `from`: it leaves from
 * there when that one starts back (`chainHours`), the way there is the
 * hop between the two destinations, and only the last of a chain goes
 * back to the quarters. Each destination stays a block of its own, so
 * "+ Spot in …", the window and the picker treat it like any excursion;
 * only the piece at the quarters between the two is gone.
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
  /**
   * When the group leaves the quarters, minutes past midnight. For an
   * excursion with `from`, when it leaves the one before: always that
   * one's `returnMinutes` (`chainHours`).
   */
  departMinutes: number;
  /** When they start back from the destination, or on to the next one. */
  returnMinutes: number;
  /**
   * The excursion of the same day this one goes on from, without the
   * way back to the quarters in between. Absent or null: from the quarters.
   */
  from?: string | null;
}

/** An excursion as read, with what the way there costs. */
export interface StoredExcursion extends Excursion {
  /**
   * One way, in minutes: from the quarters with the stay's mode, or from
   * the excursion before for one with `from`. Derived, never stored.
   */
  travelMinutes: number;
  /** Back to the quarters from here; 0 when the chain goes on from here. Derived. */
  backMinutes: number;
  /**
   * Going on to this excursion straight from the one before would be
   * shorter than the way back and out again (Anton, 13.11.). Derived;
   * absent when it already does, or when nothing is to be gained.
   */
  linkSuggestion?: LinkSuggestion;
}

/** "Von Seestadt direkt weiter: 9 min statt 59, spart 50 min". */
export interface LinkSuggestion {
  /** The excursion to go on from. */
  from: string;
  /** The hop between the two destinations. */
  hopMinutes: number;
  /** Back to the quarters from the one before and out again to this one. */
  viaQuartersMinutes: number;
}

/** Below this the app does not suggest a link: a few minutes are not worth a question. */
export const LINK_SUGGESTION_MIN_SAVING = 15;

/**
 * Which excursion could go straight on from the one before it: the
 * next one of the day that does not already, when the hop between the
 * two destinations is shorter than the way back alone and at least
 * `LINK_SUGGESTION_MIN_SAVING` shorter than going back to the quarters
 * and out again. `busyBetween` says
 * whether something is planned at the quarters after an excursion —
 * then the way back is the point, and nothing is suggested.
 */
export function linkSuggestions(
  list: readonly Excursion[],
  quarters: Coordinate,
  stayMode: TransportMode,
  busyBetween: (excursionId: string) => boolean,
): Map<string, LinkSuggestion> {
  const ways = excursionWays(list, quarters, stayMode);
  const next = chainedOn(list);
  const sorted = [...list].sort((a, b) => a.departMinutes - b.departMinutes);
  const out = new Map<string, LinkSuggestion>();
  for (let i = 1; i < sorted.length; i += 1) {
    const before = sorted[i - 1];
    const e = sorted[i];
    if (e.from || next.has(before.id) || busyBetween(before.id)) continue;
    const hopMinutes = travelLeg({ lat: before.lat, lon: before.lon }, { lat: e.lat, lon: e.lon }, dayTripMode(stayMode)).minutes;
    const viaQuartersMinutes = ways.back(before) + ways.there(e);
    // Nearer to go on than to go home (Anton, 13.11.), and worth asking.
    if (hopMinutes < ways.back(before) && viaQuartersMinutes - hopMinutes >= LINK_SUGGESTION_MIN_SAVING) {
      out.set(e.id, { from: before.id, hopMinutes, viaQuartersMinutes });
    }
  }
  return out;
}

/** The way to an excursion and the way back from it, in minutes. */
export interface ExcursionWays {
  there: (excursion: Excursion) => number;
  back: (excursion: Excursion) => number;
}

/**
 * How an excursion is reached and left. A plain function is the one-way
 * way from the quarters, used both ways; the way back of an excursion
 * the chain goes on from is then 0.
 */
export type ExcursionTravel = ExcursionWays | ((excursion: Excursion) => number);

/** The ids of the excursions another one goes on from. */
function chainedOn(list: readonly Excursion[]): Set<string> {
  const ids = new Set(list.map((e) => e.id));
  return new Set(list.flatMap((e) => (e.from && ids.has(e.from) ? [e.from] : [])));
}

function waysOf(list: readonly Excursion[], travel: ExcursionTravel): ExcursionWays {
  if (typeof travel !== "function") return travel;
  const next = chainedOn(list);
  return { there: travel, back: (e) => (next.has(e.id) ? 0 : travel(e)) };
}

/**
 * The ways of a day's excursions: from the quarters, or the hop from the
 * destination before; back only from the last of a chain. Never on foot.
 */
export function excursionWays(list: readonly Excursion[], quarters: Coordinate, stayMode: TransportMode): ExcursionWays {
  const byId = new Map(list.map((e) => [e.id, e]));
  const next = chainedOn(list);
  return {
    there: (e) => {
      const before = e.from ? byId.get(e.from) : undefined;
      return before
        ? travelLeg({ lat: before.lat, lon: before.lon }, { lat: e.lat, lon: e.lon }, dayTripMode(stayMode)).minutes
        : excursionTravel(quarters, e, stayMode);
    },
    back: (e) => (next.has(e.id) ? 0 : excursionTravel(quarters, e, stayMode)),
  };
}

/**
 * The list with every chained excursion leaving when the one before it
 * starts on, and a `from` that names no excursion of the list dropped.
 * Run before every check and every write, so the stored hours agree.
 */
export function chainHours<T extends Excursion>(list: readonly T[]): T[] {
  const byId = new Map(list.map((e) => [e.id, e]));
  const resolved = new Map<string, T>();
  const resolve = (e: T, seen: Set<string>): T => {
    const done = resolved.get(e.id);
    if (done) return done;
    const before = e.from ? byId.get(e.from) : undefined;
    let out: T;
    if (!before || before.id === e.id || seen.has(before.id)) {
      out = e.from ? { ...e, from: null } : e;
    } else {
      const head = resolve(before, new Set([...seen, e.id]));
      out = { ...e, departMinutes: head.returnMinutes };
    }
    resolved.set(e.id, out);
    return out;
  };
  return list.map((e) => resolve(e, new Set()));
}

/**
 * The excursions linked with this one: the whole chain from its first
 * destination to its last, in order. A plain excursion is a chain of one.
 */
export function chainOf<T extends Excursion>(list: readonly T[], id: string): T[] {
  const byId = new Map(list.map((e) => [e.id, e]));
  let first = byId.get(id);
  if (!first) return [];
  const seen = new Set<string>([first.id]);
  while (first.from && byId.has(first.from) && !seen.has(first.from)) {
    first = byId.get(first.from)!;
    seen.add(first.id);
  }
  const chain = [first];
  for (;;) {
    const last = chain[chain.length - 1];
    const next = list.find((e) => e.from === last.id && !chain.includes(e));
    if (!next) return chain;
    chain.push(next);
  }
}

/**
 * The list without one excursion, the chain closed over the gap: the
 * one after it goes on from the one before, or, when the first goes,
 * leaves the quarters when the first did.
 */
export function withoutExcursion<T extends Excursion>(list: readonly T[], id: string): T[] {
  const gone = list.find((e) => e.id === id);
  if (!gone) return [...list];
  return chainHours(list
    .filter((e) => e.id !== id)
    .map((e) => (e.from === id
      ? { ...e, from: gone.from ?? null, departMinutes: gone.departMinutes }
      : e)));
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

/**
 * The hours the group is away for this excursion: from leaving (the
 * quarters, or the destination before) to being back — or, when the
 * chain goes on, to leaving for the next one.
 */
export function awaySpan(excursion: Excursion, thereMinutes: number, backMinutes = thereMinutes): { from: number; to: number } {
  return { from: excursion.departMinutes, to: excursion.returnMinutes + backMinutes };
}

/** The hours the group is at the destination. */
export function thereSpan(excursion: Excursion, thereMinutes: number): { from: number; to: number } {
  return { from: excursion.departMinutes + thereMinutes, to: excursion.returnMinutes };
}

/**
 * Why a set of excursions cannot stand on one day, or null when it can.
 * Checked when one is added or moved, so the day never holds two
 * places at once or a window with no time in it.
 */
export function excursionProblem(
  excursions: readonly Excursion[],
  travel: ExcursionTravel,
): string | null {
  const ids = new Set(excursions.map((e) => e.id));
  const followers = new Map<string, number>();
  for (const e of excursions) {
    if (!e.from) continue;
    if (e.from === e.id || !ids.has(e.from)) return `${excursionLabel(e)}: den Ausflug davor gibt es an diesem Tag nicht`;
    followers.set(e.from, (followers.get(e.from) ?? 0) + 1);
    if ((followers.get(e.from) ?? 0) > 1) return "von einem Ziel geht es nur zu einem nächsten weiter";
  }
  for (const e of excursions) {
    const seen = new Set<string>();
    let at: Excursion | undefined = e;
    while (at?.from) {
      if (seen.has(at.id)) return "die Ausflüge bilden einen Kreis";
      seen.add(at.id);
      at = excursions.find((x) => x.id === at!.from);
    }
  }
  const ways = waysOf(excursions, travel);
  const spans = excursions
    .map((e) => ({ e, away: awaySpan(e, ways.there(e), ways.back(e)), there: thereSpan(e, ways.there(e)) }))
    .sort((a, b) => a.away.from - b.away.from || a.away.to - b.away.to);
  for (const { e, there } of spans) {
    if (e.returnMinutes <= e.departMinutes) {
      return e.from ? `${excursionLabel(e)}: die Rückfahrt muss nach der Weiterfahrt liegen` : "die Rückfahrt muss nach der Abfahrt liegen";
    }
    if (there.to - there.from < MIN_VIABLE_BLOCK_MINUTES) {
      return `${excursionLabel(e)}: nach der Fahrt bleibt dort keine Zeit`;
    }
    if (there.to + ways.back(e) > 24 * 60) return `${excursionLabel(e)}: die Rückkehr liegt nach Mitternacht`;
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
  travel: ExcursionTravel,
): T[] {
  if (excursions.length === 0) return [...blocks];
  const ways = waysOf(excursions, travel);
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
      const away = awaySpan(excursion, ways.there(excursion), ways.back(excursion));
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
    const there = thereSpan(excursion, ways.there(excursion));
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
