/**
 * The provisional aesthetic score (documentation/plans/foto-aesthetik.md,
 * stage 4). The embedding service keeps a linear head on the CLIP ViT-H/14
 * vector that predicts the Q-Align value; `/quality` uses it for every photo
 * it indexes once it beats the zero-shot prompts. This file trains that head
 * from the photos the nightly run has scored and then scores the photos Q-Align
 * has not reached from their stored vectors, so an existing library gets the
 * better value without reading a single image again.
 *
 * One job at a time; it runs after a nightly run that scored something and on
 * "Neu trainieren". The services come in as `HeadDeps`, so the decisions are
 * tested without them.
 */

import log from "encore.dev/log";
import { AESTHETIC_MODEL } from "./aesthetic-score";
import type { HeadSample } from "./aesthetic-store";

/** The embedding service trains nothing below this; asking earlier only costs a request. */
export const HEAD_MIN_SAMPLES = 500;
/** Enough for a 1024-dimensional linear head; more only slows the fit. */
export const HEAD_MAX_SAMPLES = 20_000;
/** Photo ids per `/aesthetic-head/score` request (the service takes up to 2000). */
export const HEAD_SCORE_BATCH = 1_000;

// The report as the embedding service sends it; written out for Encore's parser.
export interface HeadReport {
  version: string;
  /** Used for new photos: ranks the test photos closer to Q-Align than the zero-shot prompts. */
  active: boolean;
  trained_at: string;
  samples: number;
  train: number;
  validation: number;
  test: number;
  ridge_lambda: number;
  spearman_head: number;
  spearman_zero_shot: number;
  mae_head: number;
}

export interface HeadScore {
  photo_id: string;
  score: number;
}

export interface HeadDeps {
  /** Q-Align scores to learn from. */
  samples(model: string, limit: number): Promise<HeadSample[]>;
  train(samples: HeadSample[]): Promise<HeadReport>;
  /** The head's values from stored vectors; `missing` lists ids without a vector. */
  score(photoIds: string[]): Promise<{ version: string; scores: HeadScore[]; missing: string[] }>;
  provisionalBatch(headVersion: string, afterId: number, limit: number): Promise<number[]>;
  writeScore(photoId: number, headVersion: string, value: number): Promise<void>;
}

export interface HeadJob {
  trigger: "after_run" | "manual";
  status: "running" | "done" | "skipped" | "failed";
  phase: "train" | "apply" | null;
  /** Photos given the head's value so far. */
  applied: number;
  /** Photos the head could not score: no CLIP vector yet. */
  without_vector: number;
  /** Why nothing was trained or applied, in words for the page. */
  note: string | null;
  error: string | null;
  report: HeadReport | null;
  started_at: string;
  ended_at: string | null;
}

let current: HeadJob | null = null;
let running = false;

/** The job in progress, or the last one this process ran. */
export function headJob(): HeadJob | null {
  return current ? { ...current } : null;
}

/** Test hook. */
export function _resetHeadJob(): void {
  current = null;
  running = false;
}

/** Starts training and applying unless a job runs; the promise ends with the job. */
export function startHeadJob(trigger: HeadJob["trigger"], deps: HeadDeps): { started: boolean; done: Promise<void> } {
  if (running) return { started: false, done: Promise.resolve() };
  running = true;
  const job: HeadJob = {
    trigger,
    status: "running",
    phase: "train",
    applied: 0,
    without_vector: 0,
    note: null,
    error: null,
    report: null,
    started_at: new Date().toISOString(),
    ended_at: null,
  };
  current = job;
  const done = runJob(job, deps)
    .catch((err) => {
      job.status = "failed";
      job.error = (err as Error).message;
      log.warn("aesthetic head: job failed", { error: job.error });
    })
    .finally(() => {
      job.phase = null;
      job.ended_at = new Date().toISOString();
      running = false;
    });
  return { started: true, done };
}

async function runJob(job: HeadJob, deps: HeadDeps): Promise<void> {
  const samples = await deps.samples(AESTHETIC_MODEL, HEAD_MAX_SAMPLES);
  if (samples.length < HEAD_MIN_SAMPLES) {
    job.status = "skipped";
    job.note = `Erst ${samples.length} Fotos mit Q-Align-Wert, gebraucht werden ${HEAD_MIN_SAMPLES}`;
    return;
  }
  const report = await deps.train(samples);
  job.report = report;
  log.info("aesthetic head: trained", { ...report });
  if (!report.active) {
    job.status = "skipped";
    job.note = "Der Kopf trifft Q-Align nicht besser als die bisherige CLIP-Schätzung und bleibt unbenutzt";
    return;
  }

  job.phase = "apply";
  let afterId = 0;
  for (;;) {
    const ids = await deps.provisionalBatch(report.version, afterId, HEAD_SCORE_BATCH);
    if (ids.length === 0) break;
    afterId = ids[ids.length - 1]!;
    const result = await deps.score(ids.map(String));
    for (const s of result.scores) {
      await deps.writeScore(Number(s.photo_id), result.version, s.score);
      job.applied++;
    }
    job.without_vector += result.missing.length;
  }
  job.status = "done";
  log.info("aesthetic head: applied", { applied: job.applied, withoutVector: job.without_vector });
}
