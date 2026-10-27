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
  /**
   * False for a widening the model must not take on its own (hidden photos
   * counted in): its count is listed, but never recommended.
   */
  recommend?: false;
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
      return { label: p.label, count: await p.count(), recommend: p.recommend !== false };
    } catch {
      return { label: p.label, count: undefined, recommend: p.recommend !== false };
    }
  }));
  const parts = counts.map((c) => `without ${c.label}: ${countText(c.count)}`);
  if (counts.length === 1) {
    // One filter: without it the result is everything, which answers nothing.
    const only = counts[0]!;
    return `No ${what} match ${only.label} (without it: ${countText(only.count)}, which is everything). Tell the user nothing matches; search once more only with another spelling or a broader word the user's own wording allows. Do not repeat the same call.`;
  }
  const useful = counts.filter((c): c is { label: string; count: ProbeCount; recommend: boolean } => !!c.count && c.count.n > 0 && c.recommend);
  if (!useful.length) {
    return `No ${what} match. The same call with one filter dropped: ${parts.join("; ")}. No single filter explains it; tell the user nothing matches these criteria and name them. Do not search again with the same arguments.`;
  }
  // The filter whose absence brings the fewest rows was the narrowest guess
  // (the month, the account); the one that brings hundreds was the question
  // itself (the sender). Name the first, so the model does not drop the second.
  const fewest = Math.min(...useful.map((c) => c.count.n));
  const drop = useful.filter((c) => c.count.n === fewest);
  const keep = counts.filter((c) => !drop.includes(c));
  const dropText = drop.length === 1
    ? `Call again with ${drop[0]!.label} dropped and every other filter kept: that brings the ${countText(drop[0]!.count)} row${drop[0]!.count.n === 1 && !drop[0]!.count.atLeast ? "" : "s"} closest to the question.`
    : `Call again with one of ${drop.map((c) => c.label).join(" or ")} dropped and every other filter kept.`;
  const keepText = keep.length
    ? ` Dropping ${keep.map((c) => c.label).join(" or ")} instead would bring rows the user did not ask for.`
    : "";
  return `No ${what} match. The same call with one filter dropped: ${parts.join("; ")}. ${dropText}${keepText} Say which filter you dropped; if the question needs every filter, tell the user nothing matches.`;
}

/** The label of a date range, from what the call set. */
export function periodLabel(from: string | undefined, to: string | undefined): string {
  if (from && to) return `the period ${from}..${to}`;
  if (from) return `from ${from}`;
  return `to ${to}`;
}
