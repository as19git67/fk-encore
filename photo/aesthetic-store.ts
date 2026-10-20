/**
 * Database side of the nightly aesthetic job (documentation/plans/
 * foto-aesthetik.md, stage 3): the settings row, the run table, which
 * photos still need a score, and writing a score back.
 */

import { and, desc, eq, inArray, isNull, like, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import db from "../db/database";
import { dbExec, dbFirst } from "../db/adapter";
import {
  photoAestheticRun,
  photoAestheticSettings,
  photos,
  type AestheticRunStatus,
  type AestheticRunTrigger,
} from "../db/schema";
import { FAILED_SUFFIX, compositeFromDetails, parseHm, withAestheticScores, type AestheticScores } from "./aesthetic-score";

// ─── Settings ────────────────────────────────────────────────────────────────

export interface AestheticSettings {
  enabled: boolean;
  /** Local time "HH:MM" the job may start lending the GPU. */
  window_start: string;
  /** Local time "HH:MM" the GPU goes back. */
  window_end: string;
  updated_at: string;
}

const DEFAULT_SETTINGS: AestheticSettings = {
  enabled: false,
  window_start: "01:00",
  window_end: "06:00",
  updated_at: new Date(0).toISOString(),
};

export async function getAestheticSettings(): Promise<AestheticSettings> {
  const row = await dbFirst<AestheticSettings>(
    db
      .select({
        enabled: photoAestheticSettings.enabled,
        window_start: photoAestheticSettings.window_start,
        window_end: photoAestheticSettings.window_end,
        updated_at: photoAestheticSettings.updated_at,
      })
      .from(photoAestheticSettings)
      .where(eq(photoAestheticSettings.id, 1)),
  );
  return row ?? DEFAULT_SETTINGS;
}

export class InvalidSettingsError extends Error {}

/** Checks the window and saves; an unreadable time or an empty window is refused. */
export async function saveAestheticSettings(
  input: Pick<AestheticSettings, "enabled" | "window_start" | "window_end">,
): Promise<AestheticSettings> {
  const start = input.window_start.trim();
  const end = input.window_end.trim();
  if (parseHm(start) === null) throw new InvalidSettingsError(`Beginn „${start}“ ist keine Uhrzeit (HH:MM)`);
  if (parseHm(end) === null) throw new InvalidSettingsError(`Ende „${end}“ ist keine Uhrzeit (HH:MM)`);
  if (start === end) throw new InvalidSettingsError("Beginn und Ende sind gleich – das Fenster wäre leer");
  const values = { enabled: input.enabled, window_start: start, window_end: end, updated_at: sql`now()` };
  await db
    .insert(photoAestheticSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: photoAestheticSettings.id, set: values });
  return getAestheticSettings();
}

// ─── Backlog ─────────────────────────────────────────────────────────────────

/**
 * Photos that still need a score by `model`: images only (a video has no
 * frame the scorer reads), not scored by this version, and not marked as
 * unreadable by it.
 */
function needsScore(model: string): SQL {
  return and(
    like(photos.mime_type, "image/%"),
    or(
      isNull(photos.aesthetic_model),
      and(ne(photos.aesthetic_model, model), ne(photos.aesthetic_model, `${model}${FAILED_SUFFIX}`)),
    ),
  )!;
}

export async function countBacklog(model: string): Promise<number> {
  const row = await dbFirst<{ n: number }>(
    db.select({ n: sql<number>`count(*)::int` }).from(photos).where(needsScore(model)),
  );
  return row?.n ?? 0;
}

export async function countScored(model: string): Promise<number> {
  const row = await dbFirst<{ n: number }>(
    db.select({ n: sql<number>`count(*)::int` }).from(photos).where(eq(photos.aesthetic_model, model)),
  );
  return row?.n ?? 0;
}

/** The next photos to score, newest first; `skip` holds this run's transient failures. */
export async function nextBatch(model: string, limit: number, skip: number[] = []): Promise<number[]> {
  const where = skip.length ? and(needsScore(model), notInArray(photos.id, skip)) : needsScore(model);
  const rows = (await db
    .select({ id: photos.id })
    .from(photos)
    .where(where)
    .orderBy(sql`${photos.taken_at} DESC NULLS LAST`, desc(photos.id))
    .limit(limit)) as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * Writes the scorer's answer: `clip_aesthetics` and `qalign_quality` in the
 * details, the version in `aesthetic_model`, and the composite rebuilt from
 * the details. A photo the quality job has not reached yet keeps its
 * composite (usually none); that job carries the score over when it runs.
 */
export async function writeAestheticScore(photoId: number, model: string, scores: AestheticScores): Promise<void> {
  const row = await dbFirst<{ details: Record<string, number> | null; score: number | null }>(
    db
      .select({ details: photos.ai_quality_details, score: photos.ai_quality_score })
      .from(photos)
      .where(eq(photos.id, photoId)),
  );
  if (!row) return;
  const details = withAestheticScores(row.details, scores);
  const composite = compositeFromDetails(details);
  await db
    .update(photos)
    .set({
      ai_quality_details: details,
      ai_quality_score: composite ?? row.score,
      aesthetic_model: model,
    })
    .where(eq(photos.id, photoId));
}

/** Marks a photo the scorer cannot read, so the job does not try it every night. */
export async function markUnscorable(photoId: number, model: string): Promise<void> {
  await db.update(photos).set({ aesthetic_model: `${model}${FAILED_SUFFIX}` }).where(eq(photos.id, photoId));
}

/**
 * Hands photos back to the backlog: those scored (or marked unreadable) by
 * `model`, or every scored photo when no model is named.
 */
export async function resetAestheticScores(model?: string): Promise<number> {
  const where = model
    ? inArray(photos.aesthetic_model, [model, `${model}${FAILED_SUFFIX}`])
    : sql`${photos.aesthetic_model} IS NOT NULL`;
  const { changes } = await dbExec(db.update(photos).set({ aesthetic_model: null }).where(where));
  return changes;
}

// ─── Runs ────────────────────────────────────────────────────────────────────

// The unions are written out rather than taken from db/schema: this type is
// part of an API response, and Encore's parser reads it from this file.
export interface AestheticRun {
  id: number;
  trigger: "window" | "manual";
  status: "running" | "done" | "stopped" | "failed";
  phase: string | null;
  model: string | null;
  backlog: number;
  scored: number;
  failed: number;
  remaining: number | null;
  ended_reason: string | null;
  error: string | null;
  gpu_returned: boolean;
  started_at: string;
  ended_at: string | null;
}

export async function startRun(trigger: AestheticRunTrigger, backlog: number): Promise<number> {
  const [row] = (await db
    .insert(photoAestheticRun)
    .values({ trigger, backlog, phase: "start" })
    .returning({ id: photoAestheticRun.id })) as { id: number }[];
  return row!.id;
}

export type RunPatch = Partial<
  Pick<AestheticRun, "phase" | "model" | "scored" | "failed" | "remaining" | "ended_reason" | "error" | "gpu_returned" | "status">
>;

export async function updateRun(id: number, patch: RunPatch): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db.update(photoAestheticRun).set(patch).where(eq(photoAestheticRun.id, id));
}

export async function finishRun(id: number, patch: RunPatch & { status: AestheticRunStatus }): Promise<void> {
  await db
    .update(photoAestheticRun)
    .set({ ...patch, phase: null, ended_at: sql`now()` })
    .where(eq(photoAestheticRun.id, id));
}

export async function listRuns(limit = 20): Promise<AestheticRun[]> {
  return (await db
    .select()
    .from(photoAestheticRun)
    .orderBy(desc(photoAestheticRun.started_at), desc(photoAestheticRun.id))
    .limit(limit)) as AestheticRun[];
}

/**
 * Runs that still owe something: one left `running` by a process that is
 * gone, or one that ended without the GPU back. The next tick closes and
 * hands back what these left.
 */
export async function runsToRecover(exceptId: number | null): Promise<AestheticRun[]> {
  const owing = or(eq(photoAestheticRun.status, "running"), eq(photoAestheticRun.gpu_returned, false));
  const where = exceptId === null ? owing : and(owing, ne(photoAestheticRun.id, exceptId));
  return (await db.select().from(photoAestheticRun).where(where)) as AestheticRun[];
}
