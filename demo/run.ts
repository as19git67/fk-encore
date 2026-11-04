/**
 * A demo run as a background job (documentation/plans/demodaten.md): the
 * start endpoint files a `demo_run` row and returns; the job lays the
 * household down stage by stage and writes its progress into the row, which
 * the Systemstatus card polls. A run can be cancelled between batches;
 * what it wrote so far stays registered and is removed like a finished run.
 */

import { eq, inArray } from "drizzle-orm";
import log from "encore.dev/log";
import db from "../db/database";
import { demoRun } from "../db/schema";
import { llmReachable } from "./doc-text-llm";
import { writeDocuments, type TextSource } from "./doc-writer";
import { planDocuments } from "./documents";
import { planDepot } from "./depot";
import { planEnergy } from "./energy";
import { writeEnergy } from "./energy-writer";
import { createDemoDepot, loadDemoCloses } from "./depot-writer";
import { planHousehold, type DemoSize } from "./household";
import { defaultPhotoDeps, faceDetectorProblem, openverseProblem, type PhotoDeps } from "./photo-sources";
import { writePhotos, type PhotoSource } from "./photo-writer";
import { planPhotos } from "./photos";
import { currentRun, isUntouched } from "./state";
import { DemoCancelled, writeHousehold } from "./writer";

/** The household every run builds unless a test asks for another: the same seed gives the same demo. */
export const DEFAULT_SEED = 20261026;

export interface StartOptions {
  size?: DemoSize;
  seed?: number;
  /** Today as YYYY-MM-DD; the household's last day. Defaults to the server's local date. */
  today?: string;
  /**
   * Who words the documents: the local model (`llm`, hours for 500) or the
   * templates (`template`, minutes; the tests and the benchmark). Defaults
   * to the model.
   */
  text?: TextSource;
  /** Where the photos come from; the tests hand in a fake Openverse and face detector. */
  photoDeps?: PhotoDeps;
  /**
   * Parts left out (demo/bench.ts): `depot: false` asks no quote provider,
   * `photos: false` writes no photos and albums. Both default to true.
   */
  parts?: { depot?: boolean; photos?: boolean };
  /** The spouse's address when the household is laid next to the demo. */
  spouseEmail?: string;
  /** Numbers the accounts (`planHousehold`); 1, the demo's, by default. */
  accountSeries?: number;
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
        text_source: opts.text ?? "llm",
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
    const plan = planHousehold(run.seed, run.size, opts.today ?? localToday(), opts.accountSeries);

    // The depot trades at the funds' real closes; without them it is left out and the run says why.
    await setProgress(runId, "quotes", 0, 1);
    const loaded = opts.parts?.depot === false ? { skipped: "nicht angefordert" } : await loadDemoCloses(plan.from);
    await setProgress(runId, "quotes", 1, 1);
    const depot = "closes" in loaded ? planDepot(run.seed, run.size, plan, loaded.closes) : null;
    if (depot) plan.bookings.push(...depot.bookings);
    // The meters and the PV system; its bookings go on the giro account with the rest.
    const energy = planEnergy(run.seed, run.size, plan);
    plan.bookings.push(...energy.bookings);
    plan.bookings.sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account));

    await setProgress(runId, "bookings", 0, plan.bookings.length);
    const written = await writeHousehold(runId, run.owner_user_id, plan, {
      progress: (done, total) => setProgress(runId, "bookings", done, total),
      cancelled: () => cancelRequested(runId),
      spouseEmail: opts.spouseEmail,
    });

    const totalReadings = energy.meters.reduce((n, m) => n + m.readings.length, 0);
    await setProgress(runId, "meters", 0, totalReadings);
    const metered = await writeEnergy(runId, run.owner_user_id, energy, {
      progress: (done, total) => setProgress(runId, "meters", done, total),
      cancelled: () => cancelRequested(runId),
    });

    let depotId: number | null = null;
    if (depot && depot.bookings.length) {
      depotId = await createDemoDepot(runId, run.owner_user_id, [...depot.holdings.keys()]);
    }

    // The model words the documents only if it answers now; otherwise the
    // templates do, and the run says so instead of waiting 500 times.
    let text = run.text_source === "llm" ? "llm" : "template";
    if (text === "llm" && !(await llmReachable())) {
      text = "template";
      await db.update(demoRun).set({ text_source: "template" }).where(eq(demoRun.id, runId));
    }
    const docPlan = planDocuments(run.seed, run.size, plan, depot?.documents ?? []);
    await setProgress(runId, "documents", 0, docPlan.documents.length);
    const docs = await writeDocuments(runId, run.owner_user_id, run.seed, docPlan, written.bookingIds, text as TextSource, {
      progress: (done, total) => setProgress(runId, "documents", done, total),
      cancelled: () => cancelRequested(runId),
    });

    // The full demo takes CC0 photos from Openverse, checked by the face
    // detector; the small one, and a full one either does not answer for,
    // draws its pictures.
    const photoDeps = opts.photoDeps ?? defaultPhotoDeps();
    let photoSource: PhotoSource = "drawn";
    let photoNote: string | null = null;
    if (run.size === "full" && opts.parts?.photos !== false) {
      const openverse = await openverseProblem(photoDeps);
      const faces = openverse ? null : await faceDetectorProblem(photoDeps);
      if (openverse) photoNote = `Openverse nicht erreichbar (${openverse})`;
      else if (faces) photoNote = `Gesichtserkennung nicht erreichbar (${faces})`;
      else photoSource = "openverse";
    }
    const photoPlan = planPhotos(run.seed, run.size, plan);
    const withPhotos = opts.parts?.photos !== false;
    await setProgress(runId, "photos", 0, withPhotos ? photoPlan.shots.length : 0);
    const pics = withPhotos
      ? await writePhotos(runId, run.owner_user_id, run.seed, photoPlan, photoSource, {
          progress: (done, total) => setProgress(runId, "photos", done, total),
          cancelled: () => cancelRequested(runId),
        }, photoDeps)
      : { photos: 0, openverse: 0, drawn: 0, albums: 0, fallback: null };
    photoNote ??= pics.fallback;

    const notes = [
      "skipped" in loaded ? `Depot ausgelassen: ${loaded.skipped}` : null,
      photoNote && run.size === "full" ? `Fotos ${pics.drawn === pics.photos ? "" : "teils "}gezeichnet statt von Openverse: ${photoNote}` : null,
    ].filter((n): n is string => n !== null);

    await db
      .update(demoRun)
      .set({
        status: "done",
        stage: null,
        finished_at: new Date().toISOString(),
        summary: {
          users: 1,
          accounts: Object.keys(written.accounts).length,
          bookings: written.bookings,
          documents: docs.documents,
          worded: docs.worded,
          scans: docs.scans,
          depot: depotId === null ? 0 : 1,
          depot_papers: depot?.documents.length ?? 0,
          photos: pics.photos,
          photos_openverse: pics.openverse,
          photos_drawn: pics.drawn,
          albums: pics.albums,
          meters: metered.meters,
          meter_readings: metered.readings,
          businesses: 1,
        },
        // Not a failure: the run is done, these parts were left out or replaced for the reasons given.
        error: notes.length ? notes.join(" · ") : null,
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
        error: cancelled ? null : failureText(err),
        finished_at: new Date().toISOString(),
      })
      .where(eq(demoRun.id, runId));
  }
}

/** The error and, for a failed query, the database's reason behind it. */
function failureText(err: unknown): string {
  const e = err as Error & { cause?: { message?: string } };
  const cause = e.cause?.message;
  return cause && !e.message.includes(cause) ? `${e.message}: ${cause}` : e.message;
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
  // Any purpose: a benchmark run cut off by the restart is just as stuck.
  await db
    .update(demoRun)
    .set({ status: "failed", stage: null, error: "interrupted by a restart", finished_at: new Date().toISOString() })
    .where(inArray(demoRun.status, ["running", "cancelling", "removing"]));
}
