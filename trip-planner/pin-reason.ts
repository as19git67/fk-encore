/**
 * Why a spot has a fixed time (reise-planen-und-unterwegs.md, stage 3).
 *
 * A pinned spot is a booked visit: an appointment fixpoint with a
 * `spotRef`. The time was always there; what the travellers could not
 * say is *why* it is fixed — the ticket for 14:00, the sunset, the table
 * at eight, the concert, the boat that leaves. The reason changes
 * nothing in the arithmetic: every pinned spot is a hard time for the
 * day order (`day-order.ts`), whatever holds it there. It is what the
 * card shows next to the clock, so nobody moves the table at eight
 * thinking it was a guess.
 */

import { APIError } from "encore.dev/api";

// Spelled out rather than derived from the list: Encore's parser cannot
// read an indexed access type such as `(typeof PIN_REASONS)[number]`.
export type PinReason = "ticket" | "light" | "reservation" | "event" | "departure";
export const PIN_REASONS: readonly PinReason[] = ["ticket", "light", "reservation", "event", "departure"];

/** The reason as sent, or null; anything else is refused. */
export function parsePinReason(value: string | null | undefined): PinReason | null {
  if (value === undefined || value === null || value === "") return null;
  if ((PIN_REASONS as readonly string[]).includes(value)) return value as PinReason;
  throw APIError.invalidArgument(`pinReason must be one of ${PIN_REASONS.join(", ")}`);
}

/** A stored value read back; an unknown one (from a later version) is dropped. */
export function storedPinReason(value: string | null): PinReason | null {
  return value !== null && (PIN_REASONS as readonly string[]).includes(value) ? (value as PinReason) : null;
}
