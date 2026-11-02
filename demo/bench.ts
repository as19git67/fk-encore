/**
 * The demo household for the assistant benchmark (documentation/plans/
 * demodaten.md, stage 6): the same generator as the demo, laid for any
 * owner — the benchmark account — with a fixed seed, a fixed "today" and
 * the template texts, so the same call gives the same bookings, documents,
 * meters and PV business every time, and a case can compute its expected
 * answer from the same plan (`planHousehold`, `planEnergy`, …).
 *
 * Unlike the demo it is laid into a system that holds data: there is no
 * untouched check, the run carries `purpose: "benchmark"`, so Admin ›
 * Systemstatus never shows it as the demo and a demo can still be loaded
 * next to it. Its rows are registered like the demo's, and
 * `removeBenchHousehold` takes back exactly those.
 *
 * Photos are left out by default (the benchmark does not measure them), and
 * the depot too, since it asks the quote provider for real closes.
 */

import { eq } from "drizzle-orm";
import db from "../db/database";
import { demoRun } from "../db/schema";
import type { DemoSize } from "./household";
import { DEMO_EMAIL_DOMAIN } from "./names";
import { removeRun } from "./remove";
import { DEFAULT_SEED, executeRun } from "./run";

export interface BenchHouseholdOptions {
  /** Today as YYYY-MM-DD, the household's last day. Fixed, so the dates do not move between runs. */
  today: string;
  seed?: number;
  /** `small` (default): a few months, a few dozen documents. `full`: the 500 of the demo. */
  size?: DemoSize;
  /** The depot with real closes from the quote provider. Off by default. */
  depot?: boolean;
  /** Drawn photos and albums. Off by default. */
  photos?: boolean;
}

export interface BenchHousehold {
  runId: number;
  /** What the run wrote, as on the Systemstatus card (bookings, documents, meters, …). */
  summary: Record<string, number>;
  /** Parts left out and why, e.g. the depot. */
  notes: string | null;
}

/** The spouse of a benchmark household: an address of its own, so it never collides with the demo's. */
export function spouseEmailFor(runId: number): string {
  return `erika+bench-${runId}@${DEMO_EMAIL_DOMAIN}`;
}

/** The account numbers of a benchmark household: never series 1, the demo's. */
export function accountSeriesFor(runId: number): number {
  return 2 + (runId % 90_000);
}

/**
 * Lays the household for `ownerId` and waits for it. Throws when the run
 * fails. One household per owner: the meter tariffs belong to the owner, a
 * second one for the same owner is refused by the tariff check.
 */
export async function layBenchHousehold(ownerId: number, opts: BenchHouseholdOptions): Promise<BenchHousehold> {
  const [row] = await db
    .insert(demoRun)
    .values({
      owner_user_id: ownerId,
      seed: opts.seed ?? DEFAULT_SEED,
      size: opts.size ?? "small",
      text_source: "template",
      purpose: "benchmark",
      status: "running",
      stage: "household",
    })
    .returning({ id: demoRun.id });
  await executeRun(row.id, {
    today: opts.today,
    parts: { depot: opts.depot ?? false, photos: opts.photos ?? false },
    spouseEmail: spouseEmailFor(row.id),
    accountSeries: accountSeriesFor(row.id),
  });
  const [run] = await db.select().from(demoRun).where(eq(demoRun.id, row.id));
  if (run.status !== "done") {
    // Take back what it wrote before it failed, so a retry starts clean.
    await removeBenchHousehold(row.id);
    throw new Error(`benchmark household failed: ${run.error ?? run.status}`);
  }
  return { runId: row.id, summary: run.summary, notes: run.error };
}

/** Takes the household back: every registered row and file, then the run itself. */
export async function removeBenchHousehold(runId: number): Promise<void> {
  const [run] = await db.select({ purpose: demoRun.purpose }).from(demoRun).where(eq(demoRun.id, runId));
  if (!run) return;
  if (run.purpose !== "benchmark") throw new Error(`run ${runId} is the demo, not a benchmark household`);
  await removeRun(runId);
  await db.delete(demoRun).where(eq(demoRun.id, runId));
}
