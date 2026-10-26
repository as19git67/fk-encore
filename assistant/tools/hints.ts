/**
 * What a list tool says when it finds nothing (assistent-wegfindung.md,
 * stage 2): not "(0 rows)" alone, but which filter to loosen and how many
 * rows that would bring. The tool knows its filters; it offers one probe per
 * filter the call set, each the same query with that filter dropped, and
 * the probes run side by side. The model then calls again with the one
 * filter dropped that brings the rows the question is about, instead of
 * guessing or telling the user that nothing exists.
 */

/** One filter the call set, and the count of the same query without it. */
export interface Probe {
  /** How the result names the filter: `q "Flug"`, `the period`, `account_id`. */
  label: string;
  /** Rows without this filter; `undefined` when the count could not be read. */
  count: () => Promise<ProbeCount | undefined>;
}

/** A count, or "at least" when the probe read a capped page. */
export interface ProbeCount {
  n: number;
  atLeast?: boolean;
}

/** The most probes a result runs: one service call each. */
export const PROBE_CAP = 6;

export function countText(c: ProbeCount | undefined): string {
  if (!c) return "unknown";
  return c.atLeast ? `${c.n}+` : String(c.n);
}

/**
 * The hint for an empty result. Without any filter set there is nothing to
 * loosen, and the hint says so: the user has none of these at all.
 */
export async function loosenHint(what: string, probes: Probe[]): Promise<string> {
  if (!probes.length) {
    return `No ${what} at all: no filter was set, so the user has none. Say so; do not search again.`;
  }
  const counts = await Promise.all(probes.slice(0, PROBE_CAP).map(async (p) => {
    try {
      return { label: p.label, count: await p.count() };
    } catch {
      return { label: p.label, count: undefined };
    }
  }));
  const parts = counts.map((c) => `without ${c.label}: ${countText(c.count)}`);
  if (counts.length === 1) {
    // One filter: without it the result is everything, which answers nothing.
    const only = counts[0]!;
    return `No ${what} match ${only.label} (without it: ${countText(only.count)}, which is everything). Tell the user nothing matches; search once more only with another spelling or a broader word the user's own wording allows. Do not repeat the same call.`;
  }
  const useful = counts.filter((c) => c.count && c.count.n > 0);
  const advice = useful.length
    ? "Call again with the one filter dropped that keeps what the user asked for, and say which filter you dropped. If the question needs every filter, tell the user nothing matches."
    : "No single filter explains it; tell the user nothing matches these criteria and name them. Do not search again with the same arguments.";
  return `No ${what} match. The same call with one filter dropped: ${parts.join("; ")}. ${advice}`;
}

/** The label of a date range, from what the call set. */
export function periodLabel(from: string | undefined, to: string | undefined): string {
  if (from && to) return `the period ${from}..${to}`;
  if (from) return `from ${from}`;
  return `to ${to}`;
}
