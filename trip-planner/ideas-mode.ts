/**
 * A trip of ideas (plan `ideen-statt-pool.md`, stage 1): its stays
 * start with an empty list, the planner searches nothing and fills no
 * day, and every re-plan keeps what the travellers put on the days.
 * Trips from before carry no flag and keep their searched pool.
 */
export function isIdeasTrip(constraints: Record<string, unknown> | null | undefined): boolean {
  return constraints?.ideas === true;
}
