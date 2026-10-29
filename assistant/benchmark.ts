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
 * A run can ask for the CPU twin of the loaded model (`device: "cpu"`,
 * documentation/plans/foto-aesthetik.md, stage 2): the GPU is lent through
 * the llm-service for the length of the run and returned afterwards, so the
 * same cases measure the night-time configuration against the day-time one.
 *
 * A run can read real data instead of canned results (`data: "synthetic"`,
 * stage 6 part 2 of documentation/plans/assistent-wegfindung.md): the cases
 * of `bench/synthetic.ts` run with the real tools against a dataset seeded
 * for the benchmark account, and the run runs as that account. The tools
 * call the services through `~encore/clients`, which hand the caller's auth
 * along, so the admin's request starts the run through an internal call that
 * carries the benchmark account's auth (`launchSyntheticRun`); everything the
 * run reads is then that account's, and nothing of the admin's. The seeded
 * rows are removed when the run ends unless asked to stay.
 *
 *   DELETE /assistant/benchmark/synthetic-data   remove what a run left
 *
 * Permission: `data.manage`, like the other model tools.
 */

import { api, APIError, type Query } from "encore.dev/api";
import log from "encore.dev/log";
import { getAuthData } from "~encore/auth";
import { assistant, user } from "~encore/clients";
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
import {
  benchAccountUser,
  ensureBenchAccount,
  removeSyntheticData,
  seedSyntheticData,
  syntheticCases,
  syntheticRowCount,
  UNSEEDED,
  verifySight,
} from "./bench/synthetic";
import type { AssistantUser, ToolSpec } from "./types";

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

/** What the tools read: the canned results of the cases, or the synthetic database through the real services. */
export type BenchDataSource = "canned" | "synthetic";

function dataSource(value: unknown): BenchDataSource {
  return value === "synthetic" ? "synthetic" : "canned";
}

/** The cases of a data source; the synthetic ones before a seeding, for listing. */
function casesOf(data: BenchDataSource): BenchCase[] {
  return data === "synthetic" ? syntheticCases(UNSEEDED) : BENCH_CASES;
}

export const listBenchmarkCases = api(
  { expose: true, method: "GET", path: "/assistant/benchmark/cases", auth: true },
  async ({ data }: { data?: Query<BenchDataSource> }): Promise<{ today: string; cases: BenchCaseInfo[] }> => {
    admin();
    return {
      today: BENCH_TODAY,
      cases: casesOf(dataSource(data)).map((c) => ({ id: c.id, title: c.title, question: c.question, tools: c.expect.map((e) => e.tool) })),
    };
  },
);

// ── runs ──────────────────────────────────────────────────────────────────

export interface BenchModel {
  label: string;
  model_filename: string;
  backend: string;
  ctx_size: number;
  /** `cpu` or `cuda`; missing on runs filed before the GPU lease existed. */
  accelerator?: string;
  /** 0 = nothing on the card; what decides whether a run was the CPU twin. */
  gpu_layers?: number;
  /** `env`, `file` or `lease`. */
  source?: string;
}

export type BenchDevice = "loaded" | "cpu";

/**
 * Stand-ins in `current_case` while the GPU changes hands, so the page can
 * say what the run is waiting for. No case has an id with a colon.
 */
export const PHASE_LEND = "gpu:lend";
export const PHASE_RETURN = "gpu:return";
/** The same while the synthetic data is seeded and removed. */
export const PHASE_SEED = "data:seed";
export const PHASE_REMOVE = "data:remove";

/** How long a model swap may take before the run gives up on it. */
const LEASE_TIMEOUT_MS = 30 * 60_000;
const LEASE_POLL_MS = 2_000;

export interface BenchRunSummary {
  id: number;
  label: string;
  model: BenchModel | null;
  status: "running" | "done" | "failed" | "cancelled";
  /** Canned results, or the synthetic database through the real tools. */
  data_source: BenchDataSource;
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
    data_source: row.data_source,
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
    const { label, model_filename, backend, ctx_size, accelerator, gpu_layers, source } = status.live;
    return { label, model_filename, backend, ctx_size, accelerator, gpu_layers, source };
  } catch (err) {
    log.warn("assistant benchmark: model status unavailable", { error: String(err) });
    return null;
  }
}

class LeaseFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseFailedError";
  }
}

/**
 * Waits for the llm-service to finish the swap a lend or return started:
 * `ready` or `idle` means the model is up, `error` carries the reason.
 */
async function waitForSwap(what: string, signal: AbortSignal, sleep: (ms: number) => Promise<void>): Promise<void> {
  const deadline = Date.now() + LEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new BenchCancelledError();
    const { reload } = await user.getLlmGpuLease();
    if (reload.state === "ready" || reload.state === "idle") return;
    if (reload.state === "error") throw new LeaseFailedError(`${what} failed: ${reload.detail ?? "unknown error"}`);
    await sleep(LEASE_POLL_MS);
  }
  throw new LeaseFailedError(`${what} did not finish within ${LEASE_TIMEOUT_MS / 60_000} minutes`);
}

/** Sleep that ends early on cancel, so a cancelled run is not stuck in a poll. */
function sleepUnless(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
}

export interface StartBenchRequest {
  /** What the run is filed under; default: the loaded model's label. */
  label?: string;
  /** A subset of case ids; default: every case. */
  case_ids?: string[];
  /**
   * `loaded` (default) measures what the llm-service is running; `cpu`
   * lends the GPU for the run, so the cases run on the CPU twin of the
   * loaded model, and returns it when the run ends.
   */
  device?: BenchDevice;
  /**
   * `canned` (default) answers every tool with the case's fixture;
   * `synthetic` seeds the dataset of `bench/synthetic.ts` for the benchmark
   * account and runs its cases with the real tools, as that account.
   */
  data?: BenchDataSource;
  /** With `synthetic`: leave the seeded rows for a look afterwards; `DELETE …/synthetic-data` removes them. */
  keep_data?: boolean;
}

export const startBenchmarkRun = api(
  { expose: true, method: "POST", path: "/assistant/benchmark/runs", auth: true },
  async (req: StartBenchRequest): Promise<BenchRunDetail> => {
    const auth = admin();
    if (active) throw APIError.alreadyExists("a benchmark run is already in progress");

    const data = dataSource(req.data);
    const wanted = req.case_ids?.length ? new Set(req.case_ids) : null;
    const pool = casesOf(data);
    const cases = wanted ? pool.filter((c) => wanted.has(c.id)) : pool;
    if (!cases.length) throw APIError.invalidArgument("no known case selected");

    // A run marked running that this process does not hold was cut off by a restart.
    await db
      .update(assistantBenchmarkRun)
      .set({ status: "failed", error: "interrupted by a restart", finished_at: sql`now()`, current_case: null })
      .where(eq(assistantBenchmarkRun.status, "running"));

    const device: BenchDevice = req.device === "cpu" ? "cpu" : "loaded";
    const model = await currentModel();
    const baseLabel = model?.label || model?.model_filename || "unbekanntes Modell";
    const label = req.label?.trim().slice(0, 80) || (device === "cpu" ? `${baseLabel} (CPU)` : baseLabel);
    const [row] = await db
      .insert(assistantBenchmarkRun)
      .values({
        user_id: Number(auth.userID),
        label,
        model: model as unknown as Record<string, unknown> | null,
        case_ids: cases.map((c) => c.id),
        cases_total: cases.length,
        data_source: data,
        current_case: data === "synthetic" ? PHASE_SEED : device === "cpu" ? PHASE_LEND : null,
      })
      .returning();

    if (data === "synthetic") {
      // The run must act as the benchmark account, not as the admin: the
      // internal call carries that account's auth, and the tools of the run
      // inherit it from there.
      const account = await ensureBenchAccount();
      try {
        await assistant.launchSyntheticRun(
          { run_id: row.id, case_ids: cases.map((c) => c.id), device, keep_data: req.keep_data === true },
          { authData: benchAccountUser(account, benchUser().permissions) },
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await db
          .update(assistantBenchmarkRun)
          .set({ status: "failed", error: `the synthetic run could not start: ${detail}`, current_case: null, finished_at: sql`now()` })
          .where(eq(assistantBenchmarkRun.id, row.id));
        throw err;
      }
      log.info("assistant benchmark started", { run_id: row.id, cases: cases.length, label, device, data });
      return toDetail(await loadRun(row.id));
    }

    const controller = new AbortController();
    const done = execute(row.id, cases, device, controller.signal, { user: benchUser() }).finally(() => {
      if (active?.id === row.id) active = null;
    });
    active = { id: row.id, controller, done };
    log.info("assistant benchmark started", { run_id: row.id, cases: cases.length, label, device, data });
    return toDetail(row);
  },
);

export interface LaunchSyntheticRequest {
  run_id: number;
  case_ids: string[];
  device: BenchDevice;
  keep_data: boolean;
}

/**
 * Starts a synthetic run in the background, as whoever calls: the admin's
 * request calls it with the benchmark account's auth, so the seeding, the
 * real tools and the self-check all act as that account. Not exposed.
 */
export const launchSyntheticRun = api(
  { expose: false, method: "POST", path: "/assistant/benchmark/synthetic/launch" },
  async (req: LaunchSyntheticRequest): Promise<{ started: boolean }> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("the synthetic run needs the benchmark account's auth");
    if (active) throw APIError.alreadyExists("a benchmark run is already in progress");
    const row = await loadRun(req.run_id);
    if (row.status !== "running") throw APIError.failedPrecondition(`the run is already ${row.status}`);

    const as: AssistantUser = { userID: auth.userID, permissions: auth.permissions };
    const controller = new AbortController();
    const done = executeSynthetic(row.id, req.case_ids, req.device, req.keep_data, as, controller.signal).finally(() => {
      if (active?.id === row.id) active = null;
    });
    active = { id: row.id, controller, done };
    return { started: true };
  },
);

/**
 * Seeds the dataset for the account the run runs as, checks that the run
 * sees it through the services, runs the cases with the real tools, and
 * removes the data again unless asked to keep it.
 */
async function executeSynthetic(runId: number, caseIds: string[], device: BenchDevice, keep: boolean, as: AssistantUser, signal: AbortSignal): Promise<void> {
  const fail = async (error: string) => {
    await db
      .update(assistantBenchmarkRun)
      .set({ status: "failed", error, current_case: null, summary: summarize([]) as unknown as Record<string, unknown>, finished_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(assistantBenchmarkRun.id, runId));
  };
  let cases: BenchCase[];
  try {
    const ids = await seedSyntheticData(Number(as.userID));
    // The one thing that cannot be tested without the runtime: that the
    // tools act as the benchmark account. Checked once, before any case.
    await verifySight();
    const wanted = new Set(caseIds);
    cases = syntheticCases(ids).filter((c) => wanted.has(c.id));
  } catch (err) {
    log.error(err, "assistant benchmark: the synthetic data is not in place", { run_id: runId });
    await fail(err instanceof Error ? err.message : String(err));
    if (!keep) await removeSyntheticData().catch((e) => log.error(e, "assistant benchmark: removing the synthetic data failed", { run_id: runId }));
    return;
  }
  await execute(runId, cases, device, signal, {
    user: as,
    realTools: true,
    afterwards: keep
      ? undefined
      : async () => {
          await db.update(assistantBenchmarkRun).set({ current_case: PHASE_REMOVE, updated_at: sql`now()` }).where(eq(assistantBenchmarkRun.id, runId));
          await removeSyntheticData();
        },
  });
}

export const removeSyntheticBenchmarkData = api(
  { expose: true, method: "DELETE", path: "/assistant/benchmark/synthetic-data", auth: true },
  async (): Promise<{ removed: number }> => {
    admin();
    if (active) throw APIError.failedPrecondition("a benchmark run is in progress");
    const removed = await syntheticRowCount();
    await removeSyntheticData();
    return { removed };
  },
);

/**
 * Moves the model to the CPU twin for the run. Returns how to undo it: a
 * no-op when the GPU was already lent by someone else (the nightly job),
 * whose lease is not ours to end.
 */
async function lendForRun(runId: number, signal: AbortSignal): Promise<() => Promise<void>> {
  const sleep = sleepUnless(signal);
  const lent = await user.lendLlmGpu();
  const ours = lent.status === "accepted";
  if (ours) await waitForSwap("lending the GPU", signal, sleep);
  const model = await currentModel();
  await db
    .update(assistantBenchmarkRun)
    .set({ model: model as unknown as Record<string, unknown> | null, current_case: null, updated_at: sql`now()` })
    .where(eq(assistantBenchmarkRun.id, runId));
  if (!ours) return async () => {};
  return async () => {
    await db
      .update(assistantBenchmarkRun)
      .set({ current_case: PHASE_RETURN, updated_at: sql`now()` })
      .where(eq(assistantBenchmarkRun.id, runId));
    await user.returnLlmGpu();
    // Not cancellable: a cancelled run still owes the card back.
    await waitForSwap("returning the GPU", new AbortController().signal, (ms) => new Promise((r) => setTimeout(r, ms)));
  };
}

interface ExecuteOptions {
  /** Who the cases run as; the tools offered are what this user may use. */
  user: AssistantUser;
  /** The tools run for real against the user's data instead of answering with the case's fixture. */
  realTools?: boolean;
  /** Runs when the cases are through, however they ended; its failure is filed on the run. */
  afterwards?: () => Promise<void>;
}

async function execute(runId: number, cases: BenchCase[], device: BenchDevice, signal: AbortSignal, opts: ExecuteOptions): Promise<void> {
  const benchAs = opts.user;
  const tools: ToolSpec[] = catalogFor(benchAs);
  const results: CaseRun[] = [];
  let giveBack: (() => Promise<void>) | null = null;
  const finish = async (status: "done" | "failed" | "cancelled", error: string | null = null) => {
    if (opts.afterwards) {
      try {
        await opts.afterwards();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log.error(err, "assistant benchmark: the step after the cases failed", { run_id: runId });
        error = error ? `${error}; ${detail}` : `synthetic data not removed: ${detail}`;
      }
    }
    if (giveBack) {
      try {
        await giveBack();
      } catch (err) {
        // The cases are measured and kept; only the way back failed, which
        // the admin can repeat from the KI-Modell page.
        const detail = err instanceof Error ? err.message : String(err);
        log.error(err, "assistant benchmark: returning the GPU failed", { run_id: runId });
        error = error ? `${error}; ${detail}` : `GPU not returned: ${detail}`;
      }
    }
    await db
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
  };

  try {
    if (device === "cpu") giveBack = await lendForRun(runId, signal);
    for (const c of cases) {
      if (signal.aborted) throw new BenchCancelledError();
      await db
        .update(assistantBenchmarkRun)
        .set({ current_case: c.id, updated_at: sql`now()` })
        .where(eq(assistantBenchmarkRun.id, runId));
      const run = await runBenchCase(c, {
        chat,
        tools,
        realTools: opts.realTools,
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
