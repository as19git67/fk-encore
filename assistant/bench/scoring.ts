/**
 * Scoring the assistant benchmark: did the model call the right tools with
 * the right arguments, and did it end in an answer? The same rules as
 * `llm-service/bench/chat_bench.py`, plus nested keys and `$all`.
 */

import type { RoutingStage } from "../router";
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
  const first = calls.find((x) => x.tool !== "describe_tools" && x.tool !== "switch_area")?.tool;
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
  /** How many cases each router stage decided (stage 1 of assistent-wegfindung.md). */
  routed: Partial<Record<RoutingStage, number>>;
  /** Empty tool results the model followed with another call, over all empty results (stage 2); null without any. */
  empty_follow_rate: number | null;
  /** Tool errors the model followed with a corrected call of the same tool, over all tool errors (stage 2); null without any. */
  error_fix_rate: number | null;
  /** Cases the router asked a plan for, and how many of those got one (stage 3). */
  plan_asked: number;
  planned: number;
  /** Pass rate of the cases with two or more areas in play, the plan's own measure (stage 3); null without any. */
  multi_area_pass_rate: number | null;
  /** Median rounds of those cases, the plan call included; null without any. */
  median_rounds_multi_area: number | null;
  /** Pass rate of the cases that come with earlier turns, the measure of stage 4 (history as summaries); null without any. */
  follow_up_pass_rate: number | null;
  /** The checker (stage 5): check calls over all cases, how many objected, how many answers went out with a note, and the median time of a check. */
  checks: number;
  check_failed: number;
  unverified: number;
  median_check_ms: number | null;
  /** Replies llama-server could not parse and the loop asked for once more, over all cases (llama.cpp issue #25072). */
  malformed_replies: number;
}

export interface CaseRunSummaryInput {
  rounds_ms: number[];
  error: string | null;
  score: CaseScore;
  nudges?: number;
  prompt_tokens_first?: number | null;
  routing?: RoutingStage;
  empty_results?: number;
  empty_followed?: number;
  tool_errors?: number;
  errors_corrected?: number;
  areas?: string[];
  plan_asked?: boolean;
  plan?: string[];
  follow_up?: boolean;
  checks?: number;
  check_failed?: number;
  check_ms?: number | null;
  unverified?: boolean;
  malformed_replies?: number;
}

function rate(part: number, whole: number): number | null {
  return whole ? part / whole : null;
}

function total(runs: CaseRunSummaryInput[], key: "empty_results" | "empty_followed" | "tool_errors" | "errors_corrected" | "checks" | "check_failed" | "malformed_replies"): number {
  return runs.reduce((sum, r) => sum + (r[key] ?? 0), 0);
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
  // A case of two or more areas, as the router decided them (every area in play is no decision).
  const multi = runs.filter((r) => r.routing && r.routing !== "all" && (r.areas?.length ?? 0) >= 2);
  const followUps = runs.filter((r) => r.follow_up);
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
    routed: runs.reduce<Partial<Record<RoutingStage, number>>>((acc, r) => {
      if (r.routing) acc[r.routing] = (acc[r.routing] ?? 0) + 1;
      return acc;
    }, {}),
    empty_follow_rate: rate(total(runs, "empty_followed"), total(runs, "empty_results")),
    error_fix_rate: rate(total(runs, "errors_corrected"), total(runs, "tool_errors")),
    plan_asked: runs.filter((r) => r.plan_asked).length,
    planned: runs.filter((r) => r.plan).length,
    multi_area_pass_rate: rate(multi.filter((r) => r.score.passed).length, multi.length),
    median_rounds_multi_area: median(multi.filter((r) => r.rounds_ms.length).map((r) => r.rounds_ms.length)),
    follow_up_pass_rate: rate(followUps.filter((r) => r.score.passed).length, followUps.length),
    checks: total(runs, "checks"),
    check_failed: total(runs, "check_failed"),
    unverified: runs.filter((r) => r.unverified).length,
    median_check_ms: median(runs.filter((r) => r.checks && typeof r.check_ms === "number").map((r) => (r.check_ms as number) / (r.checks as number))),
    malformed_replies: total(runs, "malformed_replies"),
  };
}
