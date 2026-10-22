/**
 * The nightly aesthetic run (documentation/plans/foto-aesthetik.md, stage 3).
 *
 * Inside the configured window, and only while the LLM queue is idle, the
 * run lends the GPU (the llm-service moves Gemma 4 to its CPU twin and keeps
 * answering), loads Q-Align in the aesthetic-service, scores the backlog in
 * batches, and gives everything back: scorer unloaded, GPU returned. Between
 * batches it checks whether the window closed, the job was switched off or
 * stopped, or an admin reloaded the model (which ends the lease); any of
 * those ends the run. A run that could not hand the GPU back is marked so,
 * and the next tick retries the hand-back before anything else.
 *
 * The services and the database come in as `NightDeps`, so the decisions
 * here are tested without either; `aesthetic-deps.ts` wires the real ones.
 */

import log from "encore.dev/log";
import type { AestheticRunStatus, AestheticRunTrigger } from "../db/schema";
import { AESTHETIC_MODEL, inWindow, type AestheticScores } from "./aesthetic-score";
import type { AestheticRun, AestheticSettings, RunPatch } from "./aesthetic-store";

/** Photos per batch; the window, stop and lease are checked between batches. */
export const BATCH_SIZE = 200;
/**
 * Photos on their way to the scorer at once. The service scores one at a
 * time on the card; the second one is read, converted, uploaded and decoded
 * meanwhile, so the GPU does not wait for the CPU between photos.
 */
export const SCORE_IN_FLIGHT = 2;
/** Transient scorer failures in a row before the run gives up for the night. */
export const MAX_CONSECUTIVE_FAILURES = 5;
export const POLL_MS = 2_000;
/** A swap of Gemma between GPU and CPU: minutes, not hours. */
export const SWAP_TIMEOUT_MS = 30 * 60_000;
/** The first load downloads the weights (~16 GB) into the models volume. */
export const LOAD_TIMEOUT_MS = 2 * 60 * 60_000;
export const UNLOAD_TIMEOUT_MS = 10 * 60_000;
/**
 * How long background work for the LLM (a classification backlog, say) may
 * hold the window up. A busy queue at every tick would otherwise keep the
 * job from ever starting; the lend waits for the request in flight, and the
 * CPU twin carries on with the rest. Somebody waiting for an answer (the
 * assistant, a critique) always wins.
 */
export const BACKGROUND_PATIENCE_MS = 30 * 60_000;

export const PHASE = {
  lend: "gpu:lend",
  load: "scorer:load",
  scoring: "scoring",
  unload: "scorer:unload",
  giveBack: "gpu:return",
} as const;

export interface LeaseView {
  /** Whether the llm-service has lent its GPU (runs on the CPU twin). */
  active: boolean;
  /** The llm-service's reload state: idle, stopping, downloading, loading, ready, error. */
  reloadState: string;
  reloadDetail: string | null;
  /** Whether the llm-service has a model up and answers; a past failed reload leaves `error` behind while it does. */
  llmLoaded: boolean;
}

/** Who holds or waits for the `llm` slot: nobody, background jobs only, or somebody waiting for an answer. */
export type LlmLoad = "idle" | "background" | "interactive";

export type ScorerState = "unloaded" | "loading" | "loaded" | "unloading" | "error";

export interface ScorerStatus {
  state: "unloaded" | "loading" | "loaded" | "unloading" | "error";
  error: string | null;
  version: string | null;
}

export type ScoreOutcome =
  | { kind: "scored"; scores: AestheticScores }
  /** The photo itself is the problem (no file, not an image): marked, not retried. */
  | { kind: "unscorable"; reason: string };

export interface NightStore {
  getSettings(): Promise<AestheticSettings>;
  countBacklog(model: string): Promise<number>;
  nextBatch(model: string, limit: number, skip: number[]): Promise<number[]>;
  writeScore(photoId: number, model: string, scores: AestheticScores): Promise<void>;
  markUnscorable(photoId: number, model: string): Promise<void>;
  startRun(trigger: AestheticRunTrigger, backlog: number): Promise<number>;
  updateRun(id: number, patch: RunPatch): Promise<void>;
  finishRun(id: number, patch: RunPatch & { status: AestheticRunStatus }): Promise<void>;
  runsToRecover(exceptId: number | null): Promise<AestheticRun[]>;
}

export interface NightDeps {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  lease(): Promise<LeaseView>;
  lend(): Promise<void>;
  giveBack(): Promise<void>;
  /** Who holds or waits for the `llm` slot in ai-queue. */
  llmLoad(): Promise<LlmLoad>;
  scorerStatus(): Promise<ScorerStatus>;
  scorerLoad(): Promise<void>;
  scorerUnload(): Promise<void>;
  score(photoId: number): Promise<ScoreOutcome>;
  /** Called once a run that scored photos has closed (retrains the provisional head). */
  afterRun?(scored: number): void;
  store: NightStore;
}

class RunError extends Error {}

/** Thrown out of a wait when the run was asked to stop; ends the run without an error. */
class StoppedError extends Error {}

// ─── The one run at a time ───────────────────────────────────────────────────

interface Active {
  runId: number | null;
  trigger: AestheticRunTrigger;
  controller: AbortController;
}

let active: Active | null = null;

/** Since when background LLM work has kept tonight's window from starting; null while it has not. */
let busySince: number | null = null;

export interface TickResult {
  at: string;
  /** What the tick did, or why nothing started, in words for the page. */
  result: string;
}

let lastTickResult: TickResult | null = null;

/** The last five-minute tick in this process, if one ran since the app started. */
export function lastTick(): TickResult | null {
  return lastTickResult;
}

/** The run in progress in this process, if any. */
export function activeRun(): { runId: number | null; trigger: AestheticRunTrigger } | null {
  return active ? { runId: active.runId, trigger: active.trigger } : null;
}

/** Asks the run in progress to end after the photo it is on; false when none runs. */
export function stopActiveRun(): boolean {
  if (!active) return false;
  active.controller.abort();
  return true;
}

/** Test hook. */
export function _resetNightly(): void {
  active = null;
  busySince = null;
  lastTickResult = null;
}

export type StartResult =
  | { started: true; runId: number; done: Promise<void> }
  | { started: false; reason: string };

/**
 * Starts a run unless something speaks against it. A window run needs the
 * job switched on, the window open and the LLM idle; a manual run skips
 * those three. Both need photos to score and the GPU not lent elsewhere.
 */
export async function tryStart(trigger: AestheticRunTrigger, deps: NightDeps): Promise<StartResult> {
  if (active) return { started: false, reason: "Ein Lauf ist schon im Gang" };
  const me: Active = { runId: null, trigger, controller: new AbortController() };
  active = me;
  try {
    const reason = await blocker(trigger, deps);
    if (reason) {
      active = null;
      return { started: false, reason };
    }
    const backlog = await deps.store.countBacklog(AESTHETIC_MODEL);
    const runId = await deps.store.startRun(trigger, backlog);
    me.runId = runId;
    const done = execute(runId, trigger, deps, me.controller.signal).finally(() => {
      if (active === me) active = null;
    });
    return { started: true, runId, done };
  } catch (err) {
    if (active === me) active = null;
    throw err;
  }
}

async function blocker(trigger: AestheticRunTrigger, deps: NightDeps): Promise<string | null> {
  if (trigger === "window") {
    const settings = await deps.store.getSettings();
    if (!settings.enabled) return "Der nächtliche Lauf ist ausgeschaltet";
    if (!inWindow(deps.now(), settings.window_start, settings.window_end)) {
      busySince = null;
      return "Außerhalb des Zeitfensters";
    }
  }
  if ((await deps.store.countBacklog(AESTHETIC_MODEL)) === 0) return "Alle Fotos sind bewertet";
  const lease = await deps.lease();
  if (lease.active) return "Die GPU ist schon verliehen, etwa an einen Benchmark-Lauf";
  if (lease.reloadState === "error") {
    // The state of the last reload, not of the service: a lend the
    // llm-service rolled back, or an activation that failed, leaves `error`
    // behind until the next reload, while the model it restored answers.
    if (!lease.llmLoaded) return `Das KI-Modell meldet einen Fehler: ${lease.reloadDetail ?? "unbekannt"}`;
  } else if (lease.reloadState !== "idle" && lease.reloadState !== "ready") {
    return "Das KI-Modell lädt gerade";
  }
  if (trigger === "window") {
    const load = await deps.llmLoad();
    if (load === "interactive") return "Das KI-Modell beantwortet gerade eine Anfrage";
    if (load === "background") {
      const now = deps.now().getTime();
      busySince ??= now;
      if (now - busySince < BACKGROUND_PATIENCE_MS) return "Das KI-Modell arbeitet gerade Hintergrundaufgaben ab";
    }
  }
  busySince = null;
  return null;
}

// ─── The run ─────────────────────────────────────────────────────────────────

async function execute(runId: number, trigger: AestheticRunTrigger, deps: NightDeps, signal: AbortSignal): Promise<void> {
  const { store } = deps;
  let model = AESTHETIC_MODEL;
  let scored = 0;
  let failed = 0;
  let lent = false;
  let gpuReturned = true;
  let loaded = false;
  let endedReason: string | null = null;
  let error: string | null = null;

  const phase = (p: string) => store.updateRun(runId, { phase: p });

  try {
    await phase(PHASE.lend);
    lent = true;
    gpuReturned = false;
    await store.updateRun(runId, { gpu_returned: false });
    await deps.lend();
    await waitForSwap("Verleihen der GPU", deps);
    if (!(await deps.lease()).active) {
      // The llm-service rolled the lend back (not enough RAM for the
      // experts, say) and runs on the GPU as before.
      lent = false;
      gpuReturned = true;
      throw new RunError("Die GPU wurde nicht verliehen – das KI-Modell läuft weiter auf der GPU");
    }

    await phase(PHASE.load);
    loaded = true;
    await deps.scorerLoad();
    const status = await waitForScorer("loaded", LOAD_TIMEOUT_MS, deps, signal);
    model = status.version ?? AESTHETIC_MODEL;
    await store.updateRun(runId, { phase: PHASE.scoring, model });

    const skip: number[] = [];
    let failuresInARow = 0;
    while (endedReason === null) {
      if (signal.aborted) {
        endedReason = "Angehalten";
        break;
      }
      if (trigger === "window") {
        const settings = await store.getSettings();
        if (!settings.enabled) {
          endedReason = "Ausgeschaltet";
          break;
        }
        if (!inWindow(deps.now(), settings.window_start, settings.window_end)) {
          endedReason = "Zeitfenster zu Ende";
          break;
        }
      }
      if (!(await deps.lease()).active) {
        // An admin's reload or reset ends the lease; the GPU is theirs again.
        lent = false;
        gpuReturned = true;
        endedReason = "Das KI-Modell wurde neu geladen";
        break;
      }
      const batch = await store.nextBatch(model, BATCH_SIZE, skip);
      if (batch.length === 0) {
        endedReason = "Alle Fotos bewertet";
        break;
      }
      let next = 0;
      let gaveUp: RunError | null = null;
      const worker = async () => {
        while (next < batch.length && !signal.aborted && !gaveUp) {
          const photoId = batch[next++]!;
          try {
            const outcome = await deps.score(photoId);
            if (outcome.kind === "scored") {
              await store.writeScore(photoId, model, outcome.scores);
              scored++;
            } else {
              await store.markUnscorable(photoId, model);
              failed++;
              log.info("aesthetic: photo not scorable", { photoId, reason: outcome.reason });
            }
            failuresInARow = 0;
          } catch (err) {
            failed++;
            failuresInARow++;
            skip.push(photoId);
            log.warn("aesthetic: scoring failed", { photoId, error: (err as Error).message });
            if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
              gaveUp = new RunError(`Der Scorer antwortet nicht mehr: ${(err as Error).message}`);
            }
          }
        }
      };
      // Both workers finish the photo they are on before the run moves on.
      await Promise.all(Array.from({ length: Math.min(SCORE_IN_FLIGHT, batch.length) }, worker));
      await store.updateRun(runId, { scored, failed });
      if (gaveUp) throw gaveUp;
    }
  } catch (err) {
    if (!(err instanceof StoppedError)) {
      error = (err as Error).message;
      log.error(err, "aesthetic: run failed", { runId });
    }
  } finally {
    if (loaded) {
      try {
        await phase(PHASE.unload);
        await deps.scorerUnload();
        await waitForScorer("unloaded", UNLOAD_TIMEOUT_MS, deps);
      } catch (err) {
        error ??= `Entladen des Scorers fehlgeschlagen: ${(err as Error).message}`;
      }
    }
    if (lent) {
      try {
        await phase(PHASE.giveBack);
        gpuReturned = await handBack(deps);
      } catch (err) {
        error ??= `Rückgabe der GPU fehlgeschlagen: ${(err as Error).message}`;
      }
    }
    let remaining: number | null = null;
    try {
      remaining = await store.countBacklog(model);
    } catch {
      // The count is for the panel; a run must still close without it.
    }
    const status: AestheticRunStatus = error ? "failed" : signal.aborted ? "stopped" : "done";
    await store.finishRun(runId, {
      status,
      model,
      scored,
      failed,
      remaining,
      ended_reason: signal.aborted ? "Angehalten" : endedReason,
      error,
      gpu_returned: gpuReturned,
    });
    log.info("aesthetic: run ended", { runId, status, scored, failed, remaining, gpuReturned });
    if (scored > 0) {
      try {
        deps.afterRun?.(scored);
      } catch (err) {
        log.warn("aesthetic: after-run hook failed", { error: (err as Error).message });
      }
    }
  }
}

/** Returns the GPU if the lease is still ours; true once the llm-service runs on it again. */
async function handBack(deps: NightDeps): Promise<boolean> {
  if (!(await deps.lease()).active) return true;
  await deps.giveBack();
  await waitForSwap("Rückgabe der GPU", deps);
  return !(await deps.lease()).active;
}

async function waitForSwap(what: string, deps: NightDeps): Promise<void> {
  const deadline = deps.now().getTime() + SWAP_TIMEOUT_MS;
  while (deps.now().getTime() < deadline) {
    const lease = await deps.lease();
    if (lease.reloadState === "ready" || lease.reloadState === "idle") return;
    if (lease.reloadState === "error") throw new RunError(`${what} fehlgeschlagen: ${lease.reloadDetail ?? "unbekannt"}`);
    await deps.sleep(POLL_MS);
  }
  throw new RunError(`${what} nicht in ${SWAP_TIMEOUT_MS / 60_000} Minuten fertig`);
}

async function waitForScorer(
  target: "loaded" | "unloaded",
  timeoutMs: number,
  deps: NightDeps,
  signal?: AbortSignal,
): Promise<ScorerStatus> {
  const deadline = deps.now().getTime() + timeoutMs;
  while (deps.now().getTime() < deadline) {
    // A first load downloads for a long while; a stop must not wait for it.
    if (signal?.aborted) throw new StoppedError();
    const status = await deps.scorerStatus();
    if (status.state === target) return status;
    if (status.state === "error") {
      throw new RunError(`Der Scorer meldet einen Fehler: ${status.error ?? "unbekannt"}`);
    }
    await deps.sleep(POLL_MS, signal);
  }
  throw new RunError(`Der Scorer ist nicht in ${timeoutMs / 60_000} Minuten ${target === "loaded" ? "geladen" : "entladen"}`);
}

// ─── Recovery and the tick ───────────────────────────────────────────────────

/**
 * Closes runs a vanished process left open and hands back a GPU a run could
 * not return. Leaves the rows owing when the hand-back fails again, so the
 * next tick tries once more.
 */
export async function recover(deps: NightDeps): Promise<void> {
  const owing = await deps.store.runsToRecover(active?.runId ?? null);
  if (owing.length === 0) return;
  for (const run of owing.filter((r) => r.status === "running")) {
    await deps.store.finishRun(run.id, {
      status: "failed",
      error: "Lauf wurde unterbrochen (Neustart der App)",
      gpu_returned: run.gpu_returned,
    });
  }
  if (owing.every((r) => r.gpu_returned)) return;
  try {
    const scorer = await deps.scorerStatus();
    if (scorer.state !== "unloaded") {
      if (scorer.state !== "unloading") await deps.scorerUnload();
      await waitForScorer("unloaded", UNLOAD_TIMEOUT_MS, deps);
    }
    if (await handBack(deps)) {
      for (const run of owing) {
        if (!run.gpu_returned) await deps.store.updateRun(run.id, { gpu_returned: true });
      }
      log.info("aesthetic: GPU handed back after an earlier run", { runs: owing.map((r) => r.id) });
    }
  } catch (err) {
    log.warn("aesthetic: hand-back still failing", { error: (err as Error).message });
  }
}

/** What the five-minute job does: settle earlier runs, then start tonight's if it may. */
export async function aestheticTick(deps: NightDeps): Promise<string> {
  const note = (result: string) => {
    lastTickResult = { at: deps.now().toISOString(), result };
    return result;
  };
  if (active) return note("Ein Lauf ist im Gang");
  try {
    await recover(deps);
    const result = await tryStart("window", deps);
    if (!result.started) return note(result.reason);
    note(`Lauf ${result.runId} gestartet`);
    await result.done;
    return note(`Lauf ${result.runId} beendet`);
  } catch (err) {
    note(`Fehler: ${(err as Error).message}`);
    throw err;
  }
}
