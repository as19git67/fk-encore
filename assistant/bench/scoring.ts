/**
 * Scoring the assistant benchmark: did the model call the right tools with
 * the right arguments, and did it end in an answer? The same rules as
 * `llm-service/bench/chat_bench.py`, plus nested keys and `$all`.
 */

import type { BenchCase, Expected, ExpectedCall } from "./cases";

export interface BenchCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface CaseScore {
  /** Every expected tool was called at all. */
  tool_hit: boolean;
  /** Every expected tool was called with matching arguments. */
  args_hit: boolean;
  answered: boolean;
  passed: boolean;
  /** Expected calls no call matched, by tool name. */
  missing: string[];
  /**
   * The first call was one the case allows first (stage 6 of
   * assistent-wegfindung.md). Null when the case expects no call, or none
   * was made.
   */
  first_tool_hit?: boolean | null;
}

function loose(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value !== null && typeof value === "object") return JSON.stringify(value).normalize("NFC").toLowerCase();
  return String(value).trim().normalize("NFC").toLowerCase();
}

/** One argument against its expectation. */
export function matches(expected: Expected, actual: unknown): boolean {
  if (expected !== null && typeof expected === "object") {
    if ("$present" in expected) return actual !== undefined && actual !== null && actual !== "";
    if ("$absent" in expected) return actual === undefined || actual === null;
    if ("$all" in expected) return expected.$all.every((e) => matches(e, actual));
    if (actual === undefined || actual === null) return false;
    if ("$contains" in expected) return loose(actual).includes(loose(expected.$contains));
    if ("$in" in expected) return expected.$in.some((o) => loose(o) === loose(actual));
  }
  if (actual === undefined || actual === null) return false;
  return loose(expected) === loose(actual);
}

/** `yield.investment_group` reads `args.yield.investment_group`. */
function argAt(args: Record<string, unknown>, key: string): unknown {
  if (key in args) return args[key];
  let value: unknown = args;
  for (const part of key.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function callMatches(expect: ExpectedCall, call: BenchCall): boolean {
  if (call.tool !== expect.tool) return false;
  return Object.entries(expect.args ?? {}).every(([key, want]) => matches(want, argAt(call.args, key)));
}

/**
 * Every expected call must occur somewhere in the run, in any order. A model
 * that lists the categories first and one that searches straight away both
 * reach the right documents, so extra read calls are not penalised.
 */
export function scoreCase(c: BenchCase, calls: BenchCall[], answered: boolean, answer: string | null = null): CaseScore {
  const first_tool_hit = firstToolHit(c, calls);
  if (c.forbidTools && calls.length) {
    return { tool_hit: false, args_hit: false, answered, passed: false, missing: ["no tool call expected"], first_tool_hit };
  }
  if (c.answerMatches && !(answer && new RegExp(c.answerMatches, "i").test(answer))) {
    return { tool_hit: true, args_hit: true, answered, passed: false, missing: [`answer matching /${c.answerMatches}/`], first_tool_hit };
  }
  const called = new Set(calls.map((x) => x.tool));
  const tool_hit = c.expect.every((e) => called.has(e.tool));
  const missing = c.expect.filter((e) => !calls.some((x) => callMatches(e, x))).map((e) => e.tool);
  const args_hit = missing.length === 0;
  return { tool_hit, args_hit, answered, passed: tool_hit && args_hit && answered, missing, first_tool_hit };
}

/**
 * Did the turn start on the right road? `describe_tools` is the catalog's
 * own step, not a choice, so the first real tool counts. Null where the
 * case has no expectation to compare with.
 */
export function firstToolHit(c: BenchCase, calls: BenchCall[]): boolean | null {
  const first = calls.find((x) => x.tool !== "describe_tools")?.tool;
  if (c.forbidTools) return calls.length ? false : null;
  if (!first) return null;
  const allowed = c.firstTools ?? c.expect.map((e) => e.tool);
  if (!allowed.length) return null;
  return allowed.includes(first);
}

export interface BenchSummary {
  cases: number;
  passed: number;
  tool_hit_rate: number;
  args_hit_rate: number;
  pass_rate: number;
  errors: number;
  rounds: number;
  median_ms_per_round: number | null;
  p90_ms_per_round: number | null;
  median_rounds_per_case: number | null;
  max_rounds_used: number | null;
  /** Cases whose first call was an allowed one, over the cases with a verdict (stage 6). */
  first_tool_hit_rate: number | null;
  /** Drafts the loop sent back (grounding, fake call, consent …), over all cases. */
  nudges: number;
  median_prompt_tokens_first: number | null;
}

export interface CaseRunSummaryInput {
  rounds_ms: number[];
  error: string | null;
  score: CaseScore;
  nudges?: number;
  prompt_tokens_first?: number | null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summarize(runs: CaseRunSummaryInput[]): BenchSummary {
  const n = runs.length || 1;
  const roundMs = runs.flatMap((r) => r.rounds_ms);
  const perCase = runs.filter((r) => r.rounds_ms.length).map((r) => r.rounds_ms.length);
  const sorted = [...roundMs].sort((a, b) => a - b);
  const judged = runs.filter((r) => typeof r.score.first_tool_hit === "boolean");
  return {
    cases: runs.length,
    passed: runs.filter((r) => r.score.passed).length,
    tool_hit_rate: runs.filter((r) => r.score.tool_hit).length / n,
    args_hit_rate: runs.filter((r) => r.score.args_hit).length / n,
    pass_rate: runs.filter((r) => r.score.passed).length / n,
    errors: runs.filter((r) => r.error !== null).length,
    rounds: roundMs.length,
    median_ms_per_round: median(roundMs),
    p90_ms_per_round: sorted.length ? sorted[Math.floor(0.9 * (sorted.length - 1))] : null,
    median_rounds_per_case: median(perCase),
    max_rounds_used: perCase.length ? Math.max(...perCase) : null,
    first_tool_hit_rate: judged.length ? judged.filter((r) => r.score.first_tool_hit).length / judged.length : null,
    nudges: runs.reduce((sum, r) => sum + (r.nudges ?? 0), 0),
    median_prompt_tokens_first: median(runs.map((r) => r.prompt_tokens_first).filter((v): v is number => typeof v === "number")),
  };
}
