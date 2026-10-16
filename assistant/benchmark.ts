/**
 * The assistant benchmark on a button (documentation/plans/ki-assistent.md,
 * "Benchmark"): the cases in `bench/cases.ts` run through the real agent
 * loop against whatever model llm-service has loaded, one case after the
 * other, in the background. The page polls the run; every finished case is
 * stored at once, so a cancelled run keeps what it measured.
 *
 *   GET    /assistant/benchmark/cases
 *   POST   /assistant/benchmark/runs            start (one at a time)
 *   GET    /assistant/benchmark/runs            history, newest first
 *   GET    /assistant/benchmark/runs/:id        one run with its cases
 *   POST   /assistant/benchmark/runs/:id/cancel
 *   DELETE /assistant/benchmark/runs/:id
 *
 * Permission: `data.manage`, like the other model tools.
 */

import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import { getAuthData } from "~encore/auth";
import { user } from "~encore/clients";
import { and, desc, eq, sql } from "drizzle-orm";
import db from "../db/database";
import { assistantBenchmarkRun } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { withAiSlot } from "../ai-queue/slot-helper";
import { allTools, catalogFor } from "./catalog";
import { chat } from "./llm-client";
import { BENCH_CASES, BENCH_TODAY, type BenchCase } from "./bench/cases";
import { BenchCancelledError, runBenchCase, type CaseRun } from "./bench/runner";
import { summarize, type BenchSummary } from "./bench/scoring";
import type { AssistantUser } from "./types";

/** Behind someone waiting for an answer, ahead of nothing urgent. */
const SLOT_PRIORITY = 5;

function admin() {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("not signed in");
  requirePermission(auth, "data.manage");
  return auth;
}

/**
 * The user the cases run as: every permission any tool needs, so the whole
 * catalog is offered — the same for every run, whoever starts it.
 */
export function benchUser(): AssistantUser {
  const permissions = new Set(["module.assistant"]);
  for (const t of allTools()) for (const p of t.permissions) permissions.add(p);
  return { userID: "0", permissions: [...permissions] };
}

// ── cases ─────────────────────────────────────────────────────────────────

export interface BenchCaseInfo {
  id: string;
  title: string;
  question: string;
  /** The tools the case expects, in order. */
  tools: string[];
}

export const listBenchmarkCases = api(
  { expose: true, method: "GET", path: "/assistant/benchmark/cases", auth: true },
  async (): Promise<{ today: string; cases: BenchCaseInfo[] }> => {
    admin();
    return {
      today: BENCH_TODAY,
      cases: BENCH_CASES.map((c) => ({ id: c.id, title: c.title, question: c.question, tools: c.expect.map((e) => e.tool) })),
    };
  },
);

// ── runs ──────────────────────────────────────────────────────────────────

export interface BenchModel {
  label: string;
  model_filename: string;
  backend: string;
  ctx_size: number;
}

export interface BenchRunSummary {
  id: number;
  label: string;
  model: BenchModel | null;
  status: "running" | "done" | "failed" | "cancelled";
  cases_total: number;
  cases_done: number;
  current_case: string | null;
  summary: BenchSummary | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface BenchRunDetail extends BenchRunSummary {
  results: CaseRun[];
}

type RunRow = typeof assistantBenchmarkRun.$inferSelect;

function toSummary(row: RunRow): BenchRunSummary {
  return {
    id: row.id,
    label: row.label,
    model: (row.model as unknown as BenchModel | null) ?? null,
    status: row.status,
    cases_total: row.cases_total,
    cases_done: row.cases_done,
    current_case: row.current_case,
    summary: (row.summary as unknown as BenchSummary | null) ?? null,
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function toDetail(row: RunRow): BenchRunDetail {
  return { ...toSummary(row), results: row.results as CaseRun[] };
}

async function loadRun(id: number): Promise<RunRow> {
  const [row] = await db.select().from(assistantBenchmarkRun).where(eq(assistantBenchmarkRun.id, id)).limit(1);
  if (!row) throw APIError.notFound("benchmark run not found");
  return row;
}

/** The run in progress in this process, if any. */
let active: { id: number; controller: AbortController; done: Promise<void> } | null = null;

async function currentModel(): Promise<BenchModel | null> {
  try {
    const status = (await user.getLlmStatus()) as unknown as { live: BenchModel };
    const { label, model_filename, backend, ctx_size } = status.live;
    return { label, model_filename, backend, ctx_size };
  } catch (err) {
    log.warn("assistant benchmark: model status unavailable", { error: String(err) });
    return null;
  }
}

export interface StartBenchRequest {
  /** What the run is filed under; default: the loaded model's label. */
  label?: string;
  /** A subset of case ids; default: every case. */
  case_ids?: string[];
}

export const startBenchmarkRun = api(
  { expose: true, method: "POST", path: "/assistant/benchmark/runs", auth: true },
  async (req: StartBenchRequest): Promise<BenchRunDetail> => {
    const auth = admin();
    if (active) throw APIError.alreadyExists("a benchmark run is already in progress");

    const wanted = req.case_ids?.length ? new Set(req.case_ids) : null;
    const cases = wanted ? BENCH_CASES.filter((c) => wanted.has(c.id)) : BENCH_CASES;
    if (!cases.length) throw APIError.invalidArgument("no known case selected");

    // A run marked running that this process does not hold was cut off by a restart.
    await db
      .update(assistantBenchmarkRun)
      .set({ status: "failed", error: "interrupted by a restart", finished_at: sql`now()`, current_case: null })
      .where(eq(assistantBenchmarkRun.status, "running"));

    const model = await currentModel();
    const label = req.label?.trim().slice(0, 80) || model?.label || model?.model_filename || "unbekanntes Modell";
    const [row] = await db
      .insert(assistantBenchmarkRun)
      .values({
        user_id: Number(auth.userID),
        label,
        model: model as unknown as Record<string, unknown> | null,
        case_ids: cases.map((c) => c.id),
        cases_total: cases.length,
      })
      .returning();

    const controller = new AbortController();
    const done = execute(row.id, cases, controller.signal).finally(() => {
      if (active?.id === row.id) active = null;
    });
    active = { id: row.id, controller, done };
    log.info("assistant benchmark started", { run_id: row.id, cases: cases.length, label });
    return toDetail(row);
  },
);

async function execute(runId: number, cases: BenchCase[], signal: AbortSignal): Promise<void> {
  const benchAs = benchUser();
  const tools = catalogFor(benchAs);
  const results: CaseRun[] = [];
  const finish = (status: "done" | "failed" | "cancelled", error: string | null = null) =>
    db
      .update(assistantBenchmarkRun)
      .set({
        status,
        error,
        current_case: null,
        summary: summarize(results) as unknown as Record<string, unknown>,
        finished_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(assistantBenchmarkRun.id, runId));

  try {
    for (const c of cases) {
      if (signal.aborted) throw new BenchCancelledError();
      await db
        .update(assistantBenchmarkRun)
        .set({ current_case: c.id, updated_at: sql`now()` })
        .where(eq(assistantBenchmarkRun.id, runId));
      const run = await runBenchCase(c, {
        chat,
        tools,
        user: benchAs,
        signal,
        withSlot: (fn) => withAiSlot("llm", SLOT_PRIORITY, "assistant-benchmark", fn),
      });
      results.push(run);
      await db
        .update(assistantBenchmarkRun)
        .set({ results, cases_done: results.length, updated_at: sql`now()` })
        .where(eq(assistantBenchmarkRun.id, runId));
    }
    await finish("done");
    log.info("assistant benchmark finished", { run_id: runId, ...summarize(results) });
  } catch (err) {
    if (err instanceof BenchCancelledError) {
      await finish("cancelled");
      return;
    }
    log.error(err, "assistant benchmark failed", { run_id: runId });
    await finish("failed", err instanceof Error ? err.message : String(err));
  }
}

export const listBenchmarkRuns = api(
  { expose: true, method: "GET", path: "/assistant/benchmark/runs", auth: true },
  async (): Promise<{ runs: BenchRunSummary[] }> => {
    admin();
    const rows = await db
      .select()
      .from(assistantBenchmarkRun)
      .orderBy(desc(assistantBenchmarkRun.started_at), desc(assistantBenchmarkRun.id))
      .limit(50);
    return { runs: rows.map(toSummary) };
  },
);

export const getBenchmarkRun = api(
  { expose: true, method: "GET", path: "/assistant/benchmark/runs/:id", auth: true },
  async ({ id }: { id: number }): Promise<BenchRunDetail> => {
    admin();
    return toDetail(await loadRun(id));
  },
);

export const cancelBenchmarkRun = api(
  { expose: true, method: "POST", path: "/assistant/benchmark/runs/:id/cancel", auth: true },
  async ({ id }: { id: number }): Promise<BenchRunSummary> => {
    admin();
    const row = await loadRun(id);
    if (row.status !== "running") throw APIError.failedPrecondition(`the run is already ${row.status}`);
    if (active?.id === id) {
      // Stops before the next model round; the case in flight is not counted.
      active.controller.abort();
      await active.done;
    } else {
      await db
        .update(assistantBenchmarkRun)
        .set({ status: "cancelled", current_case: null, finished_at: sql`now()` })
        .where(and(eq(assistantBenchmarkRun.id, id), eq(assistantBenchmarkRun.status, "running")));
    }
    return toSummary(await loadRun(id));
  },
);

export const deleteBenchmarkRun = api(
  { expose: true, method: "DELETE", path: "/assistant/benchmark/runs/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    admin();
    const row = await loadRun(id);
    if (row.status === "running" && active?.id === id) throw APIError.failedPrecondition("cancel the run first");
    await db.delete(assistantBenchmarkRun).where(eq(assistantBenchmarkRun.id, id));
    return { deleted: true };
  },
);

/** Waits for the run in progress; for tests. */
export async function __settleBenchmarkForTests(): Promise<void> {
  await active?.done;
}
