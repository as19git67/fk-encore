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

import { NO_ANSWER, OUT_OF_ROUNDS, runTurn } from "../agent";
import { estimateTokens } from "../catalog";
import type { ChatFn } from "../llm-client";
import type { AssistantUser, ToolSpec } from "../types";
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

function cannedTools(c: BenchCase, tools: ToolSpec[]): ToolSpec[] {
  return tools.map((tool) => ({
    ...tool,
    async run() {
      const result = c.results[tool.name] ?? { error: "no data for this tool in the benchmark" };
      return {
        text: JSON.stringify(result),
        digest: `[benchmark result of ${tool.name}]`,
        rowCount: 1,
      };
    },
  }));
}

export async function runBenchCase(c: BenchCase, deps: RunnerDeps): Promise<CaseRun> {
  const rounds_ms: number[] = [];
  const calls: BenchCall[] = [];
  let nudges = 0;
  let prompt_tokens_first: number | null = null;
  const timed: ChatFn = async (req) => {
    if (deps.signal?.aborted) throw new BenchCancelledError();
    const started = Date.now();
    const reply = await deps.chat(req);
    rounds_ms.push(Date.now() - started);
    if (prompt_tokens_first === null) {
      prompt_tokens_first = reply.usage?.prompt_tokens ?? estimateTokens(req.messages) + estimateTokens(req.tools ?? []);
    }
    return reply;
  };

  let answer: string | null = null;
  let error: string | null = null;
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
      log: (entry) => calls.push({ tool: entry.tool, args: entry.arguments }),
    });
    // The loop's own stand-ins are not the model's answer.
    answer = result.answer === NO_ANSWER || result.answer === OUT_OF_ROUNDS ? null : result.answer;
  } catch (err) {
    if (err instanceof BenchCancelledError) throw err;
    error = err instanceof Error ? err.message : String(err);
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
    first_tool: calls.find((x) => x.tool !== "describe_tools")?.tool ?? null,
    nudges,
    prompt_tokens_first,
  };
}
