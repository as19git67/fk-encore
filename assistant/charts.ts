/**
 * Charts beside an answer (documentation/plans/assistent-diagramme.md).
 *
 * A chart shows the rows a tool returned — the rows the model read and the
 * list under the answer shows — never numbers the model wrote. It rides on
 * the block as `chart`, derived here from the block's kind and rows, so a
 * block stored before charts existed gets one when it is read again.
 */

import type { ResultBlock } from "./types";

export type ChartType = "line" | "bar" | "pie";

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface BlockChart {
  type: ChartType;
  /** The x values of a line or bar chart, the slices of a pie, in order. */
  labels: string[];
  series: ChartSeries[];
  /** How a value reads: money in `unit` (a currency code), or a plain number with `unit` after it. */
  format: "money" | "number";
  unit?: string;
  /** One line under the chart: what it leaves out. */
  caption?: string;
}

/** A pie shows at most this many slices; the smallest past it fold into one. */
export const MAX_SLICES = 8;
/** A line keeps at most this many points. */
export const MAX_POINTS = 120;

type Row = Record<string, unknown>;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** `2026-03-04…` → `04.03.2026`; anything else as it is. */
function day(v: unknown): string {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : s;
}

/**
 * Slices for a pie: largest first, the smallest past `MAX_SLICES - 1` folded
 * into „Übrige“. Null when a pie would mislead: fewer than two slices, or a
 * slice of the other sign (a pie of income and expenses has no whole).
 */
export function pieOf(entries: Array<{ label: string; value: number }>): { labels: string[]; values: number[] } | null {
  const nonZero = entries.filter((e) => e.value !== 0);
  if (nonZero.length < 2) return null;
  const negative = nonZero.every((e) => e.value < 0);
  if (!negative && nonZero.some((e) => e.value < 0)) return null;
  const sorted = nonZero
    .map((e) => ({ label: e.label, value: Math.abs(e.value) }))
    .sort((a, b) => b.value - a.value);
  const kept = sorted.length > MAX_SLICES ? sorted.slice(0, MAX_SLICES - 1) : sorted;
  const rest = sorted.slice(kept.length);
  const slices = rest.length ? [...kept, { label: "Übrige", value: rest.reduce((s, e) => s + e.value, 0) }] : kept;
  return { labels: slices.map((s) => s.label), values: slices.map((s) => round2(s.value)) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** At most `max` indices out of `length`, evenly spread, first and last kept. */
export function thinIndices(length: number, max = MAX_POINTS): number[] {
  if (length <= max) return Array.from({ length }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(Math.round((i * (length - 1)) / (max - 1)));
  return [...new Set(out)];
}

const TIME_GROUPS = new Set(["month", "quarter", "year", "day", "week"]);

/** How an analysis block was grouped: the row says it; an older block only in its subtitle. */
function analysisGrouping(block: ResultBlock, row: Row): string | null {
  const by = str(row.group_by);
  if (by) return by;
  const m = /nach (\w+)/.exec(block.subtitle ?? "");
  const label = m?.[1];
  return label === "Tag" ? "tag" : label === "Monat" ? "month" : label === "Quartal" ? "quarter" : label === "Jahr" ? "year" : null;
}

function analysisChart(block: ResultBlock): BlockChart | null {
  const row = block.rows[0];
  if (!row || !Array.isArray(row.groups)) return null;
  const groups = (row.groups as Row[])
    .map((g) => ({ label: str(g.label), value: num(g.sum) }))
    .filter((g): g is { label: string; value: number } => g.value !== null);
  if (groups.length < 2) return null;
  const currency = str(row.currency) || "EUR";
  const by = analysisGrouping(block, row);
  if (by && TIME_GROUPS.has(by)) {
    return { type: "bar", labels: groups.map((g) => g.label), series: [{ name: "Summe", values: groups.map((g) => round2(g.value)) }], format: "money", unit: currency };
  }
  const pie = pieOf(groups);
  if (pie) {
    const out = groups.every((g) => g.value <= 0);
    return {
      type: "pie", labels: pie.labels, series: [{ name: out ? "Ausgaben" : "Summe", values: pie.values }], format: "money", unit: currency,
      caption: out ? "Ausgaben als Beträge ohne Vorzeichen" : undefined,
    };
  }
  return { type: "bar", labels: groups.map((g) => g.label), series: [{ name: "Summe", values: groups.map((g) => round2(g.value)) }], format: "money", unit: currency };
}

function consumptionChart(block: ResultBlock): BlockChart | null {
  if (block.rows.length < 2) return null;
  const unit = str(block.rows[0]?.unit) || undefined;
  return {
    type: "bar",
    labels: block.rows.map((r) => str(r.period)),
    series: [{ name: "Verbrauch", values: block.rows.map((r) => num(r.consumption)) }],
    format: "number",
    unit,
  };
}

function readingsChart(block: ResultBlock): BlockChart | null {
  const rows = block.rows
    .filter((r) => num(r.value) !== null && str(r.taken_at))
    .sort((a, b) => str(a.taken_at).localeCompare(str(b.taken_at)));
  if (rows.length < 3) return null;
  return {
    type: "line",
    labels: rows.map((r) => day(r.taken_at)),
    series: [{ name: "Zählerstand", values: rows.map((r) => num(r.value)) }],
    format: "number",
    unit: str(rows[0]?.unit) || undefined,
  };
}

function positionsChart(block: ResultBlock): BlockChart | null {
  const rows = block.rows.filter((r) => r.open !== false);
  const currencies = new Set(rows.map((r) => str(r.currency) || "EUR"));
  // Values in two currencies do not share a whole.
  if (currencies.size !== 1) return null;
  const entries = rows
    .map((r) => ({ label: str(r.name) || str(r.key), value: num(r.value) }))
    .filter((e): e is { label: string; value: number } => e.value !== null && e.value > 0);
  const pie = pieOf(entries);
  if (!pie) return null;
  const cut = (block.total ?? block.rows.length) > block.rows.length;
  return {
    type: "pie", labels: pie.labels, series: [{ name: "Marktwert", values: pie.values }], format: "money", unit: [...currencies][0],
    caption: cut ? `Nur die ${block.rows.length} gezeigten von ${block.total} Positionen` : undefined,
  };
}

function performanceChart(block: ResultBlock): BlockChart | null {
  const row = block.rows[0];
  if (!row || !Array.isArray(row.points)) return null;
  const points = row.points as Row[];
  if (points.length < 2) return null;
  const idx = thinIndices(points.length);
  const pick = idx.map((i) => points[i]!);
  return {
    type: "line",
    labels: pick.map((p) => day(p.day)),
    series: [
      { name: "Depotwert", values: pick.map((p) => num(p.value)) },
      { name: "Investiertes Kapital", values: pick.map((p) => num(p.invested)) },
    ],
    format: "money",
    unit: str(row.currency) || "EUR",
    caption: block.rows.length > 1 ? `Nur ${str(row.currency)}; weitere Währungen in der Liste` : undefined,
  };
}

/** The chart of a block, or undefined when its rows make none worth drawing. */
export function chartOf(block: ResultBlock): BlockChart | undefined {
  switch (block.kind) {
    case "analysis": return analysisChart(block) ?? undefined;
    case "consumption": return consumptionChart(block) ?? undefined;
    case "readings": return readingsChart(block) ?? undefined;
    case "positions": return positionsChart(block) ?? undefined;
    case "performance": return performanceChart(block) ?? undefined;
    default: return undefined;
  }
}
