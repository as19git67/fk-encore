/**
 * Arguments the model sends, checked against the tool's own schema before
 * the tool runs (documentation/plans/assistent-wegfindung.md, stage 2).
 *
 * A tool used to swallow what it did not understand: `kind: "purchase"`
 * became "no kind", `from: "2025"` became "no period", `acount_id` became
 * nothing at all — and the model read a true-looking result for a question
 * it never asked. Now the call does not run, and the error names the
 * argument, what was sent and what is allowed, so the next call is the
 * corrected one. The checks stay shallow (one level, the shapes the schemas
 * use); a tool's own validation still runs behind them.
 */

import type { JsonSchema, ToolSpec } from "./types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** Does the description promise a date (the schemas say "YYYY-MM-DD")? */
function isDateProperty(schema: Record<string, unknown>): boolean {
  return typeof schema.description === "string" && schema.description.includes("YYYY-MM-DD");
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length]!;
}

/** The known name an unknown one most likely meant, when it is close. */
export function nearestName(name: string, known: string[]): string | undefined {
  const lower = name.toLowerCase();
  let best: { name: string; d: number } | undefined;
  for (const k of known) {
    const d = distance(lower, k.toLowerCase());
    if (!best || d < best.d) best = { name: k, d };
  }
  if (!best) return undefined;
  const within = Math.max(2, Math.floor(name.length / 3));
  return best.d <= within || lower.includes(best.name.toLowerCase()) || best.name.toLowerCase().includes(lower) ? best.name : undefined;
}

function numeric(value: unknown): boolean {
  return typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

/** The problem with one value, or null. */
function checkValue(name: string, schema: Record<string, unknown>, value: unknown): string | null {
  if (value === null) return null;
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    const options = (schema.enum as unknown[]).map(String).join(", ");
    return `${name} must be one of ${options}; got ${show(value)}`;
  }
  switch (type) {
    case "integer":
    case "number":
      if (!numeric(value)) return `${name} must be a ${type}; got ${show(value)}`;
      if (type === "integer" && !Number.isInteger(Number(value))) return `${name} must be a whole number; got ${show(value)}`;
      return null;
    case "boolean":
      if (typeof value === "boolean" || value === "true" || value === "false") return null;
      return `${name} must be true or false; got ${show(value)}`;
    case "array":
      if (!Array.isArray(value)) return `${name} must be an array; got ${show(value)}`;
      return checkItems(name, schema, value);
    case "object":
      if (value && typeof value === "object" && !Array.isArray(value)) return null;
      return `${name} must be an object; got ${show(value)}`;
    case "string":
      if (typeof value !== "string" && typeof value !== "number") return `${name} must be a string; got ${show(value)}`;
      return isDateProperty(schema) ? checkDate(name, String(value)) : null;
    default:
      return null;
  }
}

function checkItems(name: string, schema: Record<string, unknown>, value: unknown[]): string | null {
  const items = schema.items as Record<string, unknown> | undefined;
  const type = typeof items?.type === "string" ? items.type : undefined;
  if (!type) return null;
  for (const v of value) {
    if (type === "integer" || type === "number") {
      if (!numeric(v)) return `every item of ${name} must be a ${type}; got ${show(v)}`;
    } else if (type === "string") {
      if (typeof v !== "string" && typeof v !== "number") return `every item of ${name} must be a string; got ${show(v)}`;
    } else if (type === "boolean" && typeof v !== "boolean") {
      return `every item of ${name} must be true or false; got ${show(v)}`;
    }
    if (Array.isArray(items?.enum) && !items.enum.includes(v)) {
      return `every item of ${name} must be one of ${(items.enum as unknown[]).map(String).join(", ")}; got ${show(v)}`;
    }
  }
  return null;
}

/** A date argument that is not a day: a year, a month, a German date — with the day it should be. */
function checkDate(name: string, value: string): string | null {
  const s = value.trim();
  if (ISO_DATE_RE.test(s)) return null;
  const to = /(?:^|_)(?:to|until|date_to)$/.test(name);
  if (YEAR_RE.test(s)) {
    return `${name} must be a day, YYYY-MM-DD; got ${show(s)}. For the year ${s} use ${to ? `${s}-12-31` : `${s}-01-01`}`;
  }
  const month = MONTH_RE.exec(s);
  if (month) {
    const [, y, m] = month;
    const last = new Date(Number(y), Number(m), 0).getDate();
    return `${name} must be a day, YYYY-MM-DD; got ${show(s)}. For the month ${s} use ${to ? `${s}-${String(last).padStart(2, "0")}` : `${s}-01`}`;
  }
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (german) {
    const [, d, m, y] = german;
    return `${name} must be a day, YYYY-MM-DD; got ${show(s)}, which is ${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  return `${name} must be a day, YYYY-MM-DD; got ${show(s)}`;
}

/**
 * What is wrong with `args` for this tool: unknown arguments (with the name
 * most likely meant), missing required ones, wrong types, values outside an
 * enum, dates that are not days. Empty when the call may run.
 */
export function checkArguments(tool: Pick<ToolSpec, "parameters">, args: Record<string, unknown>): string[] {
  const schema: JsonSchema = tool.parameters;
  const properties = schema.properties ?? {};
  const known = Object.keys(properties);
  const problems: string[] = [];
  for (const name of Object.keys(args)) {
    if (name in properties) continue;
    const meant = nearestName(name, known);
    problems.push(`unknown argument ${name}${meant ? `; did you mean ${meant}?` : known.length ? `; the arguments are ${known.join(", ")}` : "; it takes no arguments"}`);
  }
  for (const name of schema.required ?? []) {
    if (!isSet(args[name])) problems.push(`${name} is required`);
  }
  for (const [name, value] of Object.entries(args)) {
    const prop = properties[name];
    if (!prop || value === undefined) continue;
    const problem = checkValue(name, prop, value);
    if (problem) problems.push(problem);
  }
  // `rank_by` without its order: the seventh GPU run of 2026-10-28 showed
  // that a refusal inside the tool holds in production but not in the
  // benchmark, whose tools are canned; here it holds in both.
  for (const [name, deps] of Object.entries(schema.dependentRequired ?? {})) {
    if (!isSet(args[name])) continue;
    for (const dep of deps) {
      if (isSet(args[dep])) continue;
      const prop = properties[dep];
      const values = Array.isArray(prop?.enum) ? ` — one of ${(prop!.enum as unknown[]).map(String).join(", ")}` : "";
      const about = typeof prop?.description === "string" ? ` (${prop.description})` : "";
      problems.push(`${dep} is required with ${name}${values}${about}`);
    }
  }
  return problems;
}

function isSet(v: unknown): boolean {
  return !(v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0));
}

/** The tool result of a refused call: what is wrong and what to do. */
export function argumentError(tool: string, problems: string[]): string {
  return `error: ${tool} was not run: ${problems.join("; ")}. Call ${tool} again with the corrected arguments.`;
}
