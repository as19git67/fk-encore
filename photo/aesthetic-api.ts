/**
 * Endpoints of the nightly aesthetic job (documentation/plans/
 * foto-aesthetik.md, stage 3), behind Fotos › Einstellungen › Ästhetik.
 * All of them need `data.manage`: they lend the household's GPU.
 */

import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { AESTHETIC_MODEL, inWindow, windowTimeZone } from "./aesthetic-score";
import {
  InvalidSettingsError,
  countBacklog,
  countProvisionalTargets,
  countScored,
  deleteRuns,
  getAestheticSettings,
  listRuns,
  resetAestheticScores,
  saveAestheticSettings,
  type AestheticRun,
  type AestheticSettings,
} from "./aesthetic-store";
import { activeRun, stopActiveRun, tryStart, type ScorerStatus } from "./aesthetic-nightly";
import { headStatus, realHeadDeps, realNightDeps, scorerStatus } from "./aesthetic-deps";
import { headJob, startHeadJob, type HeadJob, type HeadReport } from "./aesthetic-head";

function requireAdmin(): void {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "data.manage");
}

export interface AestheticOverview {
  settings: AestheticSettings;
  /** The zone the window is read in. */
  time_zone: string;
  in_window: boolean;
  /** The scorer version the job scores towards. */
  model: string;
  /** Photos scored by that version. */
  scored: number;
  /** Photos still waiting for it. */
  backlog: number;
  /** The run in progress in this app, if any. */
  active_run_id: number | null;
  runs: AestheticRun[];
  /** The aesthetic-service's own state; null when it did not answer. */
  scorer: ScorerStatus | null;
  scorer_error: string | null;
  /** The provisional head in the embedding service; null before the first training. */
  head: HeadReport | null;
  head_error: string | null;
  /** Photos the head would still score (no Q-Align value, not scored by this head). */
  head_pending: number | null;
  /** The training job in progress, or the last one since the app started. */
  head_job: HeadJob | null;
}

export const getAestheticOverview = api(
  { expose: true, method: "GET", path: "/photos/aesthetic", auth: true },
  async (): Promise<AestheticOverview> => {
    requireAdmin();
    const [settings, scored, backlog, runs] = await Promise.all([
      getAestheticSettings(),
      countScored(AESTHETIC_MODEL),
      countBacklog(AESTHETIC_MODEL),
      listRuns(20),
    ]);
    let scorer: ScorerStatus | null = null;
    let scorerError: string | null = null;
    try {
      scorer = await scorerStatus();
    } catch (err) {
      scorerError = (err as Error).message;
    }
    let head: HeadReport | null = null;
    let headError: string | null = null;
    let headPending: number | null = null;
    try {
      head = await headStatus();
      if (head?.active) headPending = await countProvisionalTargets(head.version);
    } catch (err) {
      headError = (err as Error).message;
    }
    const zone = windowTimeZone();
    return {
      settings,
      time_zone: zone,
      in_window: inWindow(new Date(), settings.window_start, settings.window_end, zone),
      model: AESTHETIC_MODEL,
      scored,
      backlog,
      active_run_id: activeRun()?.runId ?? null,
      runs,
      scorer,
      scorer_error: scorerError,
      head,
      head_error: headError,
      head_pending: headPending,
      head_job: headJob(),
    };
  },
);

export interface SaveAestheticSettingsRequest {
  enabled: boolean;
  window_start: string;
  window_end: string;
}

export const saveAestheticSettingsApi = api(
  { expose: true, method: "PUT", path: "/photos/aesthetic/settings", auth: true },
  async (req: SaveAestheticSettingsRequest): Promise<AestheticSettings> => {
    requireAdmin();
    try {
      return await saveAestheticSettings(req);
    } catch (err) {
      if (err instanceof InvalidSettingsError) throw APIError.invalidArgument(err.message);
      throw err;
    }
  },
);

export interface StartAestheticRunResponse {
  started: boolean;
  run_id: number | null;
  /** Why nothing started, in words for the page. */
  reason: string | null;
}

/** "Jetzt starten": a run outside the window, until the backlog is done or it is stopped. */
export const startAestheticRun = api(
  { expose: true, method: "POST", path: "/photos/aesthetic/run", auth: true },
  async (): Promise<StartAestheticRunResponse> => {
    requireAdmin();
    const result = await tryStart("manual", realNightDeps());
    if (!result.started) return { started: false, run_id: null, reason: result.reason };
    // The run takes hours; the page follows it through the overview.
    result.done.catch((err) => log.error(err, "aesthetic: manual run ended with an error"));
    return { started: true, run_id: result.runId, reason: null };
  },
);

export const stopAestheticRun = api(
  { expose: true, method: "POST", path: "/photos/aesthetic/stop", auth: true },
  async (): Promise<{ stopping: boolean }> => {
    requireAdmin();
    return { stopping: stopActiveRun() };
  },
);

export interface AestheticBackfillRequest {
  /** Only photos scored (or marked unreadable) by this version; every scored photo when absent. */
  model?: string;
}

/**
 * Hands photos back to the backlog so the next run scores them again, for a
 * new scorer version. Touches `aesthetic_model` only; the quality job and
 * the values already in the details stay as they are until the new score
 * replaces them.
 */
export const backfillAesthetic = api(
  { expose: true, method: "POST", path: "/photos/aesthetic/backfill", auth: true },
  async (req: AestheticBackfillRequest): Promise<{ marked: number }> => {
    requireAdmin();
    const model = req.model?.trim() || undefined;
    return { marked: await resetAestheticScores(model) };
  },
);

/**
 * "Neu trainieren": fits the provisional head on the Q-Align scores so far
 * and gives every photo without one the head's value. Runs on its own after
 * each nightly run that scored something; the page follows it through the
 * overview.
 */
export const trainAestheticHead = api(
  { expose: true, method: "POST", path: "/photos/aesthetic/head/train", auth: true },
  async (): Promise<{ started: boolean }> => {
    requireAdmin();
    const { started } = startHeadJob("manual", realHeadDeps());
    return { started };
  },
);

/** "Verlauf leeren": every finished run goes; a running or stranded one stays. */
export const clearAestheticRuns = api(
  { expose: true, method: "DELETE", path: "/photos/aesthetic/runs", auth: true },
  async (): Promise<{ deleted: number }> => {
    requireAdmin();
    return { deleted: await deleteRuns() };
  },
);

/** One run out of the history; refused while it still runs or owes the GPU. */
export const deleteAestheticRun = api(
  { expose: true, method: "DELETE", path: "/photos/aesthetic/runs/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: number }> => {
    requireAdmin();
    const deleted = await deleteRuns([id]);
    if (deleted === 0) throw APIError.failedPrecondition("Der Lauf ist nicht beendet oder schon gelöscht");
    return { deleted };
  },
);
