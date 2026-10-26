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
export function rankProperties<F extends string>(fields: Record<F, RankField>, fallback: NoInfer<F>): Record<string, unknown> {
  const names = Object.keys(fields) as F[];
  return {
    rank_by: {
      type: "string",
      enum: names,
      description: `order (default ${fallback}): ${names.map((n) => `${n} = ${fields[n].description}`).join("; ")}`,
    },
    direction: {
      type: "string",
      enum: ["desc", "asc"],
      description: "desc (default) = highest/newest first; asc = lowest/oldest ('die wenigsten')",
    },
  };
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

export function parseRanking<F extends string>(args: Record<string, unknown>, fields: Record<F, RankField>, fallback: NoInfer<F>): Ranking<F> {
  const s = str(args.rank_by);
  const field = s && Object.prototype.hasOwnProperty.call(fields, s) ? (s as F) : fallback;
  return { field, direction: str(args.direction) === "asc" ? "asc" : "desc" };
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
