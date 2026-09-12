/**
 * A base and day trips out of it (§4.5).
 *
 * The leg's anchor assumes the quarters move with it: Tokyo, then
 * Osaka, then Hakata — new hotel, new leg, new pool. One of the
 * commonest holidays looks nothing like that:
 *
 * > Three days in an Airbnb in San Gimignano. One day out to Pisa, one
 * > to Florence. The rest of the time in San Gimignano.
 *
 * That is **one** leg — the quarters never change, there is no transfer
 * day, the luggage stays put — and two of its three days happen forty
 * to sixty kilometres away. It could not be said at all: the anchor
 * belonged to the leg, every day inherited it, and Florence was not in
 * the pool.
 *
 * Modelling it as three legs would be wrong rather than merely
 * awkward. A leg promises its own quarters, transfer days and a pool
 * nothing slips into or out of — and "what fell through in Florence
 * does not carry over to Pisa" is the exact opposite of what the
 * traveller means.
 *
 * So a day may carry its own anchor. Missing — the ordinary case and
 * the free days at the base — the leg's applies and nothing changes.
 *
 * ## What it costs
 *
 * The way there and back come out of *that day's* blocks, the same
 * arithmetic the arrival day already uses (§4.2: "no full morning
 * block"). An hour to Florence and an hour back means the day has six
 * hours, not eight. That is why the day anchor is a planning input and
 * not a label.
 *
 * Deliberately **not** left to the solver's own per-hop travel. Planned
 * from the leg's anchor with the spots of Pisa in the pool, the drive
 * would be one hop of two and a half hours — over every leg limit
 * there is, and rightly so: inside Pisa a hop like that is a mistake.
 * The drive is a fixed cost of the day, and the day is then planned
 * around Pisa with Pisa's distances.
 */

import { MIN_VIABLE_BLOCK_MINUTES } from "./fixpoints";
import { travelLeg, type Coordinate, type TransportMode } from "./travel";

/** What a day says about where it happens. */
export interface DayAnchorInput {
  lat: number;
  lon: number;
  label?: string | null;
  radiusM?: number | null;
  /** When the group leaves the quarters, minutes past midnight. */
  departMinutes?: number | null;
  /** When they start back, from the destination. */
  returnMinutes?: number | null;
}

export interface DayTrip {
  /** Where the day is planned around. */
  at: Coordinate;
  label: string | null;
  /** How far to look around it, when the day said. */
  radiusM: number | null;
  /**
   * Getting there, in minutes. Same figure back.
   *
   * An estimate, and the day says so: two speeds and a detour factor,
   * no routing engine (§12). Where the traveller named a time it is
   * the time that counts — see the two below.
   */
  travelMinutes: number;
  /** When they set off, if anybody said. */
  departMinutes: number | null;
  /** When they start back from the destination, if anybody said. */
  returnMinutes: number | null;
}

/**
 * The day trip a day describes, or null when it stays at the base.
 *
 * A day anchor at the quarters is not a day trip: somebody who names
 * the same place has said "we stay here", and charging a zero-minute
 * drive to it would only cost the day a rounding error and a line on
 * the card.
 */
export function dayTripOf(
  legAnchor: Coordinate,
  day: DayAnchorInput | null | undefined,
  mode: TransportMode,
): DayTrip | null {
  if (!day || !Number.isFinite(day.lat) || !Number.isFinite(day.lon)) return null;
  const at = { lat: day.lat, lon: day.lon };
  const travelMinutes = travelLeg(legAnchor, at, mode).minutes;
  if (travelMinutes === 0) return null;
  return {
    at,
    label: day.label?.trim() ? day.label.trim() : null,
    radiusM: day.radiusM ?? null,
    travelMinutes,
    departMinutes: minuteOfDay(day.departMinutes),
    returnMinutes: minuteOfDay(day.returnMinutes),
  };
}

function minuteOfDay(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value >= 24 * 60) return null;
  return Math.round(value);
}

/**
 * When the day's blocks may begin, given the drive.
 *
 * A named departure plus the way there — the arrival hour is then the
 * only part still estimated, and it is shown rather than hidden, so
 * anybody can see the guess and correct it by naming the times.
 */
export function startsAtFor(dayTrip: DayTrip, ordinaryStart: number): number {
  const leaves = dayTrip.departMinutes ?? ordinaryStart;
  return leaves + dayTrip.travelMinutes;
}

/**
 * Cut the day's blocks off at the hour the group starts back.
 *
 * With a named return the drive home costs the day nothing further: it
 * happens *after* the day, exactly as an evening at the quarters
 * happens after the last block. What matters is that nothing is planned
 * past the departure — the same rule a departure fixpoint follows
 * (§4.4), and for the same reason.
 */
export function endDayAt<
  T extends { id: string; label: string; startMinutes: number; budgetMinutes: number },
>(
  blocks: readonly T[],
  returnMinutes: number,
  destination: string | null,
): { blocks: T[]; dropped: Array<{ id: string; label: string; reason: string }> } {
  const where = destination ? ` aus ${destination}` : "";
  const back = `die Rückfahrt${where} ist um ${formatMinutes(returnMinutes)}`;
  const kept: T[] = [];
  const dropped: Array<{ id: string; label: string; reason: string }> = [];

  for (const block of blocks) {
    const left = Math.min(block.budgetMinutes, returnMinutes - block.startMinutes);
    if (left < MIN_VIABLE_BLOCK_MINUTES) {
      dropped.push({ id: block.id, label: block.label, reason: `„${block.label}" fällt weg: ${back}` });
      continue;
    }
    kept.push({ ...block, budgetMinutes: left });
  }
  return { blocks: kept, dropped };
}

/** "17:00" — minutes past midnight as a time somebody reads. */
function formatMinutes(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

/**
 * What the drive home leaves of the day's last block.
 *
 * The way *there* is spent by starting the day later, which the frame
 * already knows how to do. The way back has to come off the end, and
 * off the last block that holds places: a meal block is a time and a
 * rough area (§10.3), and shortening it would move a dinner rather than
 * a drive.
 *
 * A block left with less than `MIN_VIABLE_BLOCK_MINUTES` is dropped and
 * said out loud, for the same reason a fixpoint drops one: a "Nachmittag"
 * with room for nothing is worse than an afternoon that is admittedly
 * gone.
 */
export function chargeTheWayBack<
  T extends { id: string; label: string; kind: string; budgetMinutes: number },
>(
  blocks: readonly T[],
  travelMinutes: number,
  destination: string | null,
): { blocks: T[]; dropped: Array<{ id: string; label: string; reason: string }> } {
  if (travelMinutes <= 0) return { blocks: [...blocks], dropped: [] };

  const lastSpots = lastIndexOfSpots(blocks);
  if (lastSpots === -1) return { blocks: [...blocks], dropped: [] };

  const where = destination ? ` von ${destination}` : "";
  const back = `die Rückfahrt${where} braucht ${travelMinutes} Minuten`;
  const kept: T[] = [];
  const dropped: Array<{ id: string; label: string; reason: string }> = [];

  for (const [index, block] of blocks.entries()) {
    if (index !== lastSpots) {
      kept.push(block);
      continue;
    }
    const left = block.budgetMinutes - travelMinutes;
    if (left < MIN_VIABLE_BLOCK_MINUTES) {
      dropped.push({
        id: block.id,
        label: block.label,
        reason: `„${block.label}" fällt weg: ${back}`,
      });
      continue;
    }
    kept.push({ ...block, budgetMinutes: left });
  }
  return { blocks: kept, dropped };
}

function lastIndexOfSpots(blocks: readonly { kind: string }[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].kind === "spots") return i;
  }
  return -1;
}
