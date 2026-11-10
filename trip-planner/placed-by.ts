/**
 * Who put a stop on its day (stage 8 of `reise-planen-und-unterwegs.md`).
 *
 * "hand" is a person: dragged, moved or placed with "+ Tag n". Such a
 * stop is firm and the app never moves it. "fill" is "Tag füllen": a
 * soft stop, which goes back to the open spots once its day is over
 * without it (`open-return.ts`).
 */

export type PlacedBy = "hand" | "fill";

/** A stored value, read back; anything unknown is a person's. */
export function placedByOf(value: unknown): PlacedBy {
  return value === "fill" ? "fill" : "hand";
}
