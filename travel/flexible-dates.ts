/**
 * Flexible dates: every stay (or trip) between an earliest start and a
 * latest end, lasting `minNights` to `maxNights`, and the turn of the one a
 * check prices next. Shared by hotel and flight watches.
 *
 * Plain functions without I/O.
 */

export interface DateCombo {
  start: string;
  /** Null for a one-way trip (no nights). */
  end: string | null;
}

export interface CombinationInput {
  /** Earliest start. */
  from: string;
  /** Latest end. */
  to: string;
  minNights: number | null;
  maxNights: number | null;
  /** Only starts after this day. */
  today: string;
}

/** More combinations than this are cut, the earliest starts kept. */
export const MAX_COMBINATIONS = 120;

function parseIso(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(iso: string, days: number): string {
  return new Date(parseIso(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Every start after `today` from `from`, each with every length that ends by `to`; earliest start first, shortest first. */
export function stayCombinations(input: CombinationInput): DateCombo[] {
  const out: DateCombo[] = [];
  const oneWay = input.minNights === null && input.maxNights === null;
  const min = input.minNights ?? 0;
  const max = input.maxNights ?? min;
  for (let start = input.from; start <= input.to; start = addDays(start, 1)) {
    if (start <= input.today) continue;
    if (oneWay) {
      out.push({ start, end: null });
    } else {
      for (let n = min; n <= max; n++) {
        const end = addDays(start, n);
        if (end > input.to) break;
        out.push({ start, end });
      }
    }
    if (out.length >= MAX_COMBINATIONS) return out.slice(0, MAX_COMBINATIONS);
  }
  return out;
}

/** A stable key for a combination, e.g. "2027-05-12/2027-05-15". */
export function comboKey(c: DateCombo): string {
  return `${c.start}/${c.end ?? ""}`;
}

/** The combination after `lastIndex` (−1: none checked yet), wrapping around. */
export function rotationPick<T extends DateCombo>(combos: T[], lastIndex: number): { combo: T; index: number } {
  if (!combos.length) throw new Error("rotationPick: no combinations");
  const index = (((lastIndex + 1) % combos.length) + combos.length) % combos.length;
  return { combo: combos[index], index };
}
