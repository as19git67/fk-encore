/**
 * The quarters travel along (§21.3).
 *
 * On a cruise the lodging is the same for three weeks and somewhere
 * else every morning. The model keeps that simple: a port day is an
 * ordinary leg whose anchor is the pier, the sea in between is a
 * journey by ship, and what sets the port day apart is one property —
 * leaving it means being back aboard, not catching a train.
 *
 * That changes the one fixpoint a journey writes onto the day it
 * leaves. A missed train costs an hour; a missed ship costs the trip.
 * So the departure is called what the ship's crew calls it, and it
 * keeps an hour in hand rather than twenty minutes. A tender port adds
 * the boat ride back on top — the pier is not the ship there.
 */

import type { FixpointRequest } from "./plans";

/** In front of "Alle an Bord": an hour, not the twenty minutes of a train. */
export const ALL_ABOARD_BUFFER_MINUTES = 60;
/** The tender back to the ship, when the ship lies off the harbour. */
export const TENDER_EXTRA_MINUTES = 30;

export interface AboardLeg {
  anchor: { lat: number; lon: number };
  quartersAboard: boolean;
  tenderPort: boolean;
}

/** How much a port day keeps in hand before the ship leaves. */
export function allAboardBuffer(leg: Pick<AboardLeg, "tenderPort">): number {
  return ALL_ABOARD_BUFFER_MINUTES + (leg.tenderPort ? TENDER_EXTRA_MINUTES : 0);
}

/**
 * The departure a journey puts on the last day of the leg it leaves.
 * From a hotel it is the journey on; from a port day with the quarters
 * aboard it is "Alle an Bord", with the ship's margin.
 */
export function journeyDeparture(
  leg: AboardLeg,
  nextTitle: string,
  departAt: string,
  lastDayIndex: number,
): FixpointRequest {
  const base = {
    dayIndex: lastDayIndex,
    at: departAt,
    kind: "departure" as const,
    // The journey sets off from the base: the day ends there, and the
    // way to it is the day's own last walk.
    lat: leg.anchor.lat,
    lon: leg.anchor.lon,
    travelMinutes: 0,
  };
  if (!leg.quartersAboard) return { ...base, label: `Weiterreise nach ${nextTitle}` };
  return { ...base, label: "Alle an Bord", bufferMinutes: allAboardBuffer(leg) };
}

/**
 * Whether a fixpoint is the one `journeyDeparture` wrote: the departure
 * at the base. Used to find it again when the leg's property changes
 * after the journey was made.
 */
export function isJourneyDeparture(
  fix: { kind?: string; lat?: number | null; lon?: number | null },
  anchor: { lat: number; lon: number },
): boolean {
  return fix.kind === "departure" && fix.lat === anchor.lat && fix.lon === anchor.lon;
}
