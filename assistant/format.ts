/**
 * Tool results for the model: compact tables, capped in rows, with ids and
 * totals — never whole records. Fifty known tools do not help when one
 * result of 500 bookings fills the window.
 */

export const DEFAULT_ROW_CAP = 25;

export type Cell = string | number | boolean | null | undefined;

function cell(value: Cell, width = 60): string {
  if (value === null || value === undefined || value === "") return "-";
  const text = String(value).replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

/**
 * A pipe table: header, then up to `cap` rows, then a line that says how
 * many were left out, so the model never mistakes a page for the whole set.
 */
export function table(
  columns: string[],
  rows: Cell[][],
  opts: { total?: number; cap?: number; note?: string } = {},
): string {
  const cap = opts.cap ?? DEFAULT_ROW_CAP;
  const shown = rows.slice(0, cap);
  const total = opts.total ?? rows.length;
  const lines = [columns.join(" | "), ...shown.map((r) => r.map((v) => cell(v)).join(" | "))];
  if (total > shown.length) lines.push(`(${shown.length} of ${total} shown)`);
  else lines.push(`(${total} row${total === 1 ? "" : "s"})`);
  if (opts.note) lines.push(opts.note);
  return lines.join("\n");
}

export function digestOf(tool: string, count: number, ids: Array<string | number>): string {
  const head = ids.slice(0, 20).join(",");
  return `[earlier result of ${tool}: ${count} row${count === 1 ? "" : "s"}${head ? `, ids ${head}${ids.length > 20 ? ",…" : ""}` : ""}]`;
}

/** A query string from the set values only. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function int(v: unknown, opts: { min?: number; max?: number } = {}): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  let out = Math.trunc(n);
  if (opts.min !== undefined) out = Math.max(opts.min, out);
  if (opts.max !== undefined) out = Math.min(opts.max, out);
  return out;
}

export function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/** An ISO date argument, or undefined when the model sent something else. */
export function isoDate(v: unknown): string | undefined {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) ? s.slice(0, 10) : undefined;
}

export function money(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v ?? "-");
}
