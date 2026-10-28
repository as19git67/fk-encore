/**
 * Runs one benchmark case through the assistant's own agent loop: the real
 * system prompt, the real catalog (deferred schemas and describe_tools
 * included, when the catalog is that large), the real context budget. Only
 * the tools are replaced by the case's canned results, so nothing is read
 * from or written to the user's data.
 *
 * Each model round is timed inside the ai-queue slot, so time spent waiting
 * behind other work does not count.
 */

import { NO_ANSWER, OUT_OF_ROUNDS, runTurn, WRITE_PLAN_NAME } from "../agent";
import type { AreaId } from "../areas/index";
import { estimateTokens } from "../catalog";
import { MalformedReplyError, type ChatFn, type ChatRequest } from "../llm-client";
import { isRouterRequest, type RoutingStage } from "../router";
import { isCheckRequest, verifyByDefault } from "../verify";
import type { AssistantUser, ToolOutcome, ToolSpec } from "../types";
import { BENCH_TODAY, type BenchCase } from "./cases";
import { scoreCase, type BenchCall, type CaseScore } from "./scoring";

export interface CaseRun {
  id: string;
  title: string;
  /** Milliseconds per model round, in order. */
  rounds_ms: number[];
  calls: BenchCall[];
  answer: string | null;
  error: string | null;
  score: CaseScore;
  // ── the road taken (stage 6 of assistent-wegfindung.md) ──
  /** Model rounds, the retries after a nudge included. */
  rounds: number;
  /** The first tool the model chose; `describe_tools` does not count. */
  first_tool: string | null;
  /** Drafts the loop withdrew and sent back (grounding, fake call, consent …). */
  nudges: number;
  /** What round 1 cost in prompt tokens: the model's count, else the estimate. */
  prompt_tokens_first: number | null;
  // ── the router (stage 1) ──
  /** The areas in play at the end of the turn. */
  areas?: AreaId[];
  /** How the first areas were decided: keywords, inherited, model, or all (no decision). */
  routing?: RoutingStage;
  /** Milliseconds of the router's model call, when there was one; the loop rounds are in `rounds_ms`. */
  router_ms?: number | null;
  // ── tools written for the model (stage 2) ──
  /** Tool results with no rows, and how many of them the model followed with another call instead of answering. */
  empty_results?: number;
  empty_followed?: number;
  /** Tool calls that ended in an error (refused arguments or a failing tool), and how many the model followed with a corrected call of the same tool. */
  tool_errors?: number;
  errors_corrected?: number;
  // ── the plan of a multi-step question (stage 3) ──
  /** The router asked for a plan (two areas, or chain words). */
  plan_asked?: boolean;
  /** What the plan call came back with: the plan, a real tool call (used as round 1), or nothing usable. */
  plan_reply?: "plan" | "tool_call" | "none";
  /** The steps the model planned, by tool; absent when it wrote no usable plan. */
  plan?: string[];
  /** How many of them got done. */
  plan_done?: number;
  // ── the context (stage 4) ──
  /** The case is a follow-up: it comes with earlier turns, whole or as summaries. */
  follow_up?: boolean;
  /** Stage 5: check calls of the turn, how many found a claim the results do not hold, their time, and whether the answer went out with a note. */
  checks?: number;
  check_failed?: number;
  check_ms?: number | null;
  /** Replies llama-server could not parse and the loop asked for once more; absent when none. */
  malformed_replies?: number;
  unverified?: boolean;
}

/** One call as the loop logged it: with its row count or error, never row content. */
interface TraceEntry {
  tool: string;
  args: Record<string, unknown>;
  rows: number;
  error?: string;
}

/**
 * The stage-2 counts from a turn's trace: an empty result is "followed" when
 * any call comes after it; an error is "corrected" when the same tool runs
 * later with other arguments and no error.
 */
export function followUps(trace: TraceEntry[]): Pick<CaseRun, "empty_results" | "empty_followed" | "tool_errors" | "errors_corrected"> {
  let empty_results = 0;
  let empty_followed = 0;
  let tool_errors = 0;
  let errors_corrected = 0;
  trace.forEach((entry, i) => {
    const later = trace.slice(i + 1);
    if (entry.error) {
      tool_errors++;
      if (later.some((e) => e.tool === entry.tool && !e.error && JSON.stringify(e.args) !== JSON.stringify(entry.args))) errors_corrected++;
    } else if (entry.rows === 0) {
      empty_results++;
      if (later.length) empty_followed++;
    }
  });
  return { empty_results, empty_followed, tool_errors, errors_corrected };
}

/** The plan call of a turn: bound to write_plan. */
function isPlanRequest(req: ChatRequest): boolean {
  const choice = req.tool_choice;
  return typeof choice === "object" && choice !== null && choice.function?.name === WRITE_PLAN_NAME;
}

export interface RunnerDeps {
  chat: ChatFn;
  /** Every tool the benchmark user may use; their `run` is replaced. */
  tools: ToolSpec[];
  user: AssistantUser;
  withSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
  signal?: AbortSignal;
}

export class BenchCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "BenchCancelledError";
  }
}

/** Noon of the benchmark's fixed "today", so every period resolves the same. */
export function benchNow(): Date {
  const [y, m, d] = BENCH_TODAY.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/**
 * A canned result as the case wrote it. `{ $sequence: [a, b] }` hands the
 * first call a, the second b and every later call the last entry, so a case
 * can show an empty result and then rows. `rows: []` counts as no rows,
 * `hint` goes along as the tool's hint (`loosen` as its drop/keep advice),
 * and `{ $error: "…" }` fails the call as a tool would.
 */
function cannedTools(c: BenchCase, tools: ToolSpec[]): ToolSpec[] {
  const calls = new Map<string, number>();
  return tools.map((tool) => ({
    ...tool,
    async run(args) {
      const n = calls.get(tool.name) ?? 0;
      calls.set(tool.name, n + 1);
      let result: unknown = c.results[tool.name] ?? { error: "no data for this tool in the benchmark" };
      if (result && typeof result === "object" && Array.isArray((result as { $sequence?: unknown }).$sequence)) {
        const seq = (result as { $sequence: unknown[] }).$sequence;
        result = seq[Math.min(n, seq.length - 1)];
      }
      const record = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null;
      if (typeof record?.$error === "string") throw new Error(record.$error);
      const { hint: hinted, loosen, ...rest } = record ?? {};
      const rows = Array.isArray(rest.rows) ? rest.rows.length : undefined;
      // A hint may depend on the call (what a letter left out): a function of the arguments.
      const hint = typeof hinted === "function" ? (hinted as (a: Record<string, unknown>) => string | undefined)(args) : hinted;
      return {
        text: JSON.stringify(record ? rest : result),
        digest: `[benchmark result of ${tool.name}]`,
        rowCount: rows ?? 1,
        hint: typeof hint === "string" ? hint : undefined,
        loosen: loosen && typeof loosen === "object" ? loosen as ToolOutcome["loosen"] : undefined,
      };
    },
  }));
}

export async function runBenchCase(c: BenchCase, deps: RunnerDeps): Promise<CaseRun> {
  const rounds_ms: number[] = [];
  const calls: BenchCall[] = [];
  const trace: TraceEntry[] = [];
  let nudges = 0;
  let prompt_tokens_first: number | null = null;
  let router_ms: number | null = null;
  let check_ms: number | null = null;
  const timed: ChatFn = async (req) => {
    if (deps.signal?.aborted) throw new BenchCancelledError();
    const started = Date.now();
    const reply = await deps.chat(req);
    if (isRouterRequest(req)) {
      // The router's call is not a loop round: measured apart, and never
      // the prompt of round 1.
      router_ms = (router_ms ?? 0) + Date.now() - started;
      return reply;
    }
    if (isCheckRequest(req)) {
      // Nor is the checker's (stage 5): its time is what the check costs the answer.
      check_ms = (check_ms ?? 0) + Date.now() - started;
      return reply;
    }
    rounds_ms.push(Date.now() - started);
    if (isPlanRequest(req)) plan_asked = true;
    // The plan call, when there is one, carries the prompt of round 1 plus
    // one tool: what the model counted there is the round-1 figure.
    if (prompt_tokens_first === null) {
      prompt_tokens_first = reply.usage?.prompt_tokens ?? estimateTokens(req.messages) + estimateTokens(req.tools ?? []);
    }
    return reply;
  };

  let answer: string | null = null;
  let error: string | null = null;
  let areas: AreaId[] | undefined;
  let routing: RoutingStage | undefined;
  let plan: string[] | undefined;
  let plan_done: number | undefined;
  let plan_asked = false;
  let plan_reply: CaseRun["plan_reply"];
  let checks: number | undefined;
  let check_failed: number | undefined;
  let unverified = false;
  let malformed_replies: number | undefined;
  try {
    const result = await runTurn({
      user: c.permissions ? { userID: deps.user.userID, permissions: c.permissions } : deps.user,
      history: c.history ?? [],
      question: c.question,
      tools: cannedTools(c, deps.tools),
      chat: timed,
      now: benchNow(),
      previousRefs: c.previous,
      context: c.context,
      withSlot: deps.withSlot,
      emit: (event) => { if (event.type === "retract") nudges++; },
      log: (entry) => {
        calls.push({ tool: entry.tool, args: entry.arguments });
        trace.push({ tool: entry.tool, args: entry.arguments, rows: entry.rows, error: entry.error });
      },
      routeModel: true,
      verify: verifyByDefault(),
    });
    areas = result.areas;
    if (result.checks) {
      checks = result.checks.calls;
      check_failed = result.checks.failed;
      if (result.checks.unverified !== undefined) unverified = true;
    }
    routing = result.routing;
    if (result.plan) {
      plan = result.plan.map((s) => s.tool);
      plan_done = result.plan.filter((s) => s.done).length;
    }
    plan_reply = result.planOutcome;
    malformed_replies = result.malformedReplies;
    // The loop's own stand-ins are not the model's answer.
    answer = result.answer === NO_ANSWER || result.answer === OUT_OF_ROUNDS ? null : result.answer;
  } catch (err) {
    if (err instanceof BenchCancelledError) throw err;
    error = err instanceof Error ? err.message : String(err);
    // The replies sent once more before the loop gave up count as well.
    if (err instanceof MalformedReplyError && err.repeated) malformed_replies = err.repeated;
  }
  return {
    id: c.id,
    title: c.title,
    rounds_ms,
    calls,
    answer,
    error,
    score: scoreCase(c, calls, answer !== null, answer),
    rounds: rounds_ms.length,
    first_tool: calls.find((x) => x.tool !== "describe_tools" && x.tool !== "switch_area")?.tool ?? null,
    nudges,
    prompt_tokens_first,
    areas,
    routing,
    router_ms,
    ...followUps(trace),
    plan_asked,
    ...(plan_reply ? { plan_reply } : {}),
    ...(plan ? { plan, plan_done } : {}),
    follow_up: (c.history?.length ?? 0) > 0,
    ...(checks !== undefined ? { checks, check_failed, check_ms, unverified } : {}),
    ...(malformed_replies ? { malformed_replies } : {}),
  };
}
