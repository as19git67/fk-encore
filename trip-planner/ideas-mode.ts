/**
 * A trip of ideas (plan `ideen-statt-pool.md`, stage 1): its stays
 * start with an empty list, the planner searches nothing and fills no
 * day, and every re-plan keeps what the travellers put on the days.
 * Trips from before carry no flag and keep their searched pool.
 */
export function isIdeasTrip(constraints: Record<string, unknown> | null | undefined): boolean {
  return constraints?.ideas === true;
}

/**
 * Whether the travellers' votes count (ideas plan, stage 7). A trip of
 * ideas votes only once somebody switched it on — the priority of each
 * idea says what the vote used to; a trip from before keeps voting, as
 * it always did, until somebody switches it off.
 */
export function votingOn(constraints: Record<string, unknown> | null | undefined): boolean {
  if (typeof constraints?.voting === "boolean") return constraints.voting;
  return !isIdeasTrip(constraints);
}
