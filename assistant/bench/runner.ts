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
  const timed: ChatFn = async (req) => {
    if (deps.signal?.aborted) throw new BenchCancelledError();
    const started = Date.now();
    const reply = await deps.chat(req);
    rounds_ms.push(Date.now() - started);
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
      log: (entry) => calls.push({ tool: entry.tool, args: entry.arguments }),
    });
    // The loop's own stand-ins are not the model's answer.
    answer = result.answer === NO_ANSWER || result.answer === OUT_OF_ROUNDS ? null : result.answer;
  } catch (err) {
    if (err instanceof BenchCancelledError) throw err;
    error = err instanceof Error ? err.message : String(err);
  }
  return { id: c.id, title: c.title, rounds_ms, calls, answer, error, score: scoreCase(c, calls, answer !== null, answer) };
}
