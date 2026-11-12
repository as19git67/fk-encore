/**
 * Flexible dates for the price watches (hotels and flights).
 *
 * A watch that is flexible about when and how long names a window — the
 * earliest start (check-in, outbound flight) and the latest end (check-out,
 * return flight) — and a range of nights. Every start/end pair that fits is
 * one combination. Searching all of them every day would spend the month's
 * SerpApi searches within days, so a flexible watch checks one combination
 * per day and walks through them in turn (`rotationPick`); the price of a
 * combination stays what its last check found until its turn comes again.
 *
 * Plain functions without I/O.
 */

export interface FlexibleWindow {
  /** Earliest start, `YYYY-MM-DD`. */
  from: string;
  /** Latest end (or latest start, when there is no end), `YYYY-MM-DD`. */
  to: string;
  /** Null for a trip without an end (a one-way flight). */
  minNights: number | null;
  maxNights: number | null;
  /** Starts on or before this day are gone. */
  today: string;
}

export interface DateCombination {
  start: string;
  /** Null for a one-way flight. */
  end: string | null;
}

/** More combinations than this make a rotation that takes months. */
export const MAX_COMBINATIONS = 120;

const DAY_MS = 86_400_000;

function toTime(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function toIso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toIso(toTime(iso) + days * DAY_MS);
}

/**
 * Every combination in the window that has not begun, earliest start first,
 * shorter stays first on the same start.
 */
export function stayCombinations(w: FlexibleWindow): DateCombination[] {
  const out: DateCombination[] = [];
  const first = Math.max(toTime(w.from), toTime(w.today) + DAY_MS);
  const last = toTime(w.to);
  for (let t = first; t <= last; t += DAY_MS) {
    const start = toIso(t);
    if (w.minNights === null || w.maxNights === null) {
      out.push({ start, end: null });
      continue;
    }
    for (let n = w.minNights; n <= w.maxNights; n++) {
      const end = t + n * DAY_MS;
      if (end > last) break;
      out.push({ start, end: toIso(end) });
    }
  }
  return out;
}

/** A stable key for a combination, e.g. to find its last check. */
export function comboKey(c: DateCombination): string {
  return `${c.start}|${c.end ?? ""}`;
}

/**
 * The combination to check next. `lastIndex` is the index checked last
 * (`flex_rotation` on the watch), -1 before the first check. Returns null
 * when no combination is left.
 */
export function rotationPick(
  combos: DateCombination[],
  lastIndex: number,
): { combo: DateCombination; index: number } | null {
  if (!combos.length) return null;
  const index = (Math.max(-1, Math.trunc(lastIndex)) + 1) % combos.length;
  return { combo: combos[index]!, index };
}
