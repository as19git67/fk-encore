/**
 * Ranking and grouping, the same in every list tool: `rank_by` names a
 * field of the list, `direction` its order, `group_by` splits the ranked
 * rows into groups and `per_group` keeps the first rows of each. "Das beste
 * Foto je Jahr", "die größte Buchung je Monat" and "das älteste Dokument je
 * Absender" are then one call with four arguments, not a loop the model
 * has to write. A new field is one more entry in the tool's table, never a
 * new parameter.
 *
 * The rows come already ranked (the service sorted them), so a group is the
 * first `per_group` rows that share a key, in rank order; the groups keep
 * the order of their first row.
 */

import { int, str } from "../format";

export interface RankField {
  /** What the model reads next to the name. */
  description: string;
}

export interface Ranking<F extends string> {
  field: F;
  direction: "asc" | "desc";
}

export interface Grouping<G extends string> {
  by: G;
  perGroup: number;
}

/** The most rows a group keeps; a report, not a list. */
export const PER_GROUP_MAX = 10;

/** `rank_by` and `direction` for a tool's parameters, from its field table. */
/**
 * The name of the order argument: `direction` unless the tool already uses
 * that word for something else (list_transactions: money in or out).
 */
export const ORDER_KEY = "direction";

export function rankProperties<F extends string>(fields: Record<F, RankField>, fallback: NoInfer<F>, orderKey = ORDER_KEY): Record<string, unknown> {
  const names = Object.keys(fields) as F[];
  return {
    rank_by: {
      type: "string",
      enum: names,
      description: `order (default ${fallback}): ${names.map((n) => `${n} = ${fields[n].description}`).join("; ")}; always with ${orderKey}`,
    },
    [orderKey]: {
      type: "string",
      enum: ["desc", "asc"],
      description: "desc = highest/newest/most first ('die größte', 'die meisten', 'die besten'); asc = lowest/oldest/fewest first ('die kleinste', 'die wenigsten', 'das älteste'). Required with rank_by.",
    },
  };
}

/**
 * The schema's `dependentRequired` for the ranking: `rank_by` needs its
 * order. The loop's argument check refuses the call before the tool runs
 * (`checkArguments`), so the refusal holds in the benchmark too, whose
 * tools never run; `parseRanking` below is the same rule inside the tool.
 */
export function rankRequires(orderKey = ORDER_KEY): Record<string, string[]> {
  return { rank_by: [orderKey] };
}

/** `group_by` and `per_group` for a tool's parameters, from its group table. */
export function groupProperties<G extends string>(groups: Record<G, string>): Record<string, unknown> {
  const names = Object.keys(groups) as G[];
  return {
    group_by: {
      type: "string",
      enum: names,
      description: `'für jedes/je …': the first per_group rows of every ${names.map((n) => `${n} (${groups[n]})`).join(", ")} in rank_by order`,
    },
    per_group: { type: "integer", description: `rows per group, 1 (default) to ${PER_GROUP_MAX}` },
  };
}

/**
 * `rank_by` without its order is refused: the GPU runs of 2026-10-27/28
 * never set `asc` for "die wenigsten" on their own, and a wrong default
 * answers the opposite question with a confident row. The error names
 * both values, and the corrected call comes a round later.
 */
export function parseRanking<F extends string>(args: Record<string, unknown>, fields: Record<F, RankField>, fallback: NoInfer<F>, orderKey = ORDER_KEY): Ranking<F> {
  const s = str(args.rank_by);
  const field = s && Object.prototype.hasOwnProperty.call(fields, s) ? (s as F) : fallback;
  const order = str(args[orderKey]);
  if (s && !order) {
    throw new Error(`rank_by ${s} needs ${orderKey}: "desc" for the largest, most or newest first, "asc" for the smallest, fewest or oldest first`);
  }
  return { field, direction: order === "asc" ? "asc" : "desc" };
}

export function parseGrouping<G extends string>(args: Record<string, unknown>, groups: Record<G, string>): Grouping<G> | undefined {
  const s = str(args.group_by);
  if (!s || !Object.prototype.hasOwnProperty.call(groups, s)) return undefined;
  return { by: s as G, perGroup: int(args.per_group, { min: 1, max: PER_GROUP_MAX }) ?? 1 };
}

export interface Group<T> {
  key: string;
  rows: T[];
}

/**
 * The first `perGroup` rows of every key, in the order the rows came; a row
 * without a key (no date, no sender) lands under `(none)`.
 */
export function groupRows<T>(rows: T[], keyOf: (row: T) => string | undefined, perGroup: number): Group<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row) ?? "(none)";
    const bucket = groups.get(key);
    if (bucket) {
      if (bucket.length < perGroup) bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, rows }));
}

/** Group keys from a date: the year, the month, or the quarter. */
export function dateKey(date: string | null | undefined, unit: "year" | "month" | "quarter"): string | undefined {
  if (!date || date.length < 7) return undefined;
  if (unit === "year") return date.slice(0, 4);
  if (unit === "month") return date.slice(0, 7);
  const month = Number(date.slice(5, 7));
  return Number.isFinite(month) && month >= 1 ? `${date.slice(0, 4)}-Q${Math.ceil(month / 3)}` : undefined;
}

/** The sentence a table note carries about the order and the grouping. */
export function rankNote(ranking: Ranking<string>, grouping: Grouping<string> | undefined, groupCount: number): string {
  const order = `${ranking.field} ${ranking.direction === "asc" ? "ascending (lowest or oldest first)" : "descending (highest or newest first)"}`;
  if (!grouping) return `ordered by ${order}`;
  return `ordered by ${order}, ${grouping.perGroup === 1 ? "the first row" : `the first ${grouping.perGroup} rows`} of each ${grouping.by} (${groupCount} groups); the group column says which`;
}
