/**
 * A demo run as a background job (documentation/plans/demodaten.md): the
 * start endpoint files a `demo_run` row and returns; the job lays the
 * household down stage by stage and writes its progress into the row, which
 * the Systemstatus card polls. A run can be cancelled between batches;
 * what it wrote so far stays registered and is removed like a finished run.
 */

import { eq } from "drizzle-orm";
import log from "encore.dev/log";
import db from "../db/database";
import { demoRun } from "../db/schema";
import { planHousehold, type DemoSize } from "./household";
import { currentRun, isUntouched } from "./state";
import { DemoCancelled, writeHousehold } from "./writer";

/** The household every run builds unless a test asks for another: the same seed gives the same demo. */
export const DEFAULT_SEED = 20261026;

export interface StartOptions {
  size?: DemoSize;
  seed?: number;
  /** Today as YYYY-MM-DD; the household's last day. Defaults to the server's local date. */
  today?: string;
}

/** Thrown when the system is not untouched or a demo is there already. */
export class DemoRefused extends Error {}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The run being started in this process: a second click must not start a second run. */
let starting = false;

/**
 * Files a run for `ownerId` and returns its id; `execute` lays it down.
 * Refused when the system holds anything already or a demo exists.
 */
export async function fileRun(ownerId: number, opts: StartOptions = {}): Promise<number> {
  if (starting) throw new DemoRefused("a demo run is being started already");
  starting = true;
  try {
    const existing = await currentRun();
    if (existing) throw new DemoRefused(`a demo exists already (run ${existing.id}, ${existing.status}) — remove it first`);
    if (!(await isUntouched())) throw new DemoRefused("the system holds data already — demo data is only loaded into an untouched system");
    const [row] = await db
      .insert(demoRun)
      .values({
        owner_user_id: ownerId,
        seed: opts.seed ?? DEFAULT_SEED,
        size: opts.size ?? "full",
        // Stage 1 has template texts only; the LLM texts come with the documents (stage 2).
        text_source: "template",
        status: "running",
        stage: "household",
      })
      .returning({ id: demoRun.id });
    return row.id;
  } finally {
    starting = false;
  }
}

async function setProgress(runId: number, stage: string, done: number, total: number): Promise<void> {
  const [row] = await db.select({ progress: demoRun.progress }).from(demoRun).where(eq(demoRun.id, runId));
  await db
    .update(demoRun)
    .set({ stage, progress: { ...(row?.progress ?? {}), [stage]: { done, total } } })
    .where(eq(demoRun.id, runId));
}

async function cancelRequested(runId: number): Promise<boolean> {
  const [row] = await db.select({ status: demoRun.status }).from(demoRun).where(eq(demoRun.id, runId));
  return row?.status === "cancelling";
}

/** Lays the run down. Never throws: the outcome is written into the run's row. */
export async function executeRun(runId: number, opts: StartOptions = {}): Promise<void> {
  const [run] = await db.select().from(demoRun).where(eq(demoRun.id, runId));
  if (!run || run.owner_user_id === null) return;
  try {
    const plan = planHousehold(run.seed, run.size, opts.today ?? localToday());
    await setProgress(runId, "bookings", 0, plan.bookings.length);
    const written = await writeHousehold(runId, run.owner_user_id, plan, {
      progress: (done, total) => setProgress(runId, "bookings", done, total),
      cancelled: () => cancelRequested(runId),
    });
    await db
      .update(demoRun)
      .set({
        status: "done",
        stage: null,
        finished_at: new Date().toISOString(),
        summary: { users: 1, accounts: Object.keys(written.accounts).length, bookings: written.bookings },
      })
      .where(eq(demoRun.id, runId));
  } catch (err) {
    const cancelled = err instanceof DemoCancelled;
    if (!cancelled) log.error(err as Error, "demo run failed", { runId });
    await db
      .update(demoRun)
      .set({
        status: cancelled ? "cancelled" : "failed",
        stage: null,
        error: cancelled ? null : (err as Error).message,
        finished_at: new Date().toISOString(),
      })
      .where(eq(demoRun.id, runId));
  }
}

/** Asks a running run to stop at its next batch. */
export async function requestCancel(runId: number): Promise<void> {
  await db.update(demoRun).set({ status: "cancelling" }).where(eq(demoRun.id, runId));
}

/**
 * A run the process was working on when it stopped stays "running" in the
 * table forever otherwise; at boot it is marked failed, so the card offers
 * to remove what it wrote.
 */
export async function markInterruptedRuns(): Promise<void> {
  const run = await currentRun();
  if (run && (run.status === "running" || run.status === "cancelling" || run.status === "removing")) {
    await db
      .update(demoRun)
      .set({ status: "failed", stage: null, error: "interrupted by a restart", finished_at: new Date().toISOString() })
      .where(eq(demoRun.id, run.id));
  }
}
