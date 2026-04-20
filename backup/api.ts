/**
 * Internal endpoints that coordinate the backup flow.
 *
 * The flow is intentionally ASYNC: /start validates and kicks off the prep
 * work in the background, then returns 202 immediately. The host-side cron
 * script polls /status until `phase === "ready"` before taking its ZFS
 * snapshot, then calls /stop. This decouples the HTTP timeout on the host
 * from the (potentially minutes-long) pg_dump on the server.
 *
 *   POST /internal/backup/start
 *     - 202 Accepted, returns { label, startedAt, dumpFile, phase: "draining" }
 *     - Enters maintenance mode immediately.
 *     - In the background: pauseWorkers -> pg_backup_start -> pg_dump -> phase:"ready"
 *     - Arms a safety timer (BACKUP_AUTO_STOP_MS) that force-stops if /stop
 *       never arrives.
 *
 *   GET  /internal/backup/status
 *     - { active, phase, label, startedAt, dumpFile, error }
 *     - Phase is one of idle | draining | dumping | ready | stopping | failed.
 *
 *   POST /internal/backup/stop
 *     - phase=ready   : unwind (pg_backup_stop + resumeWorkers), -> idle
 *     - phase=failed  : acknowledge failure, clear state -> idle
 *     - phase=idle    : no-op
 *     - phase=stopping: 409 "already stopping"
 *     - phase=draining/dumping: 409 "still preparing, poll /status"
 *
 * Auth (defence in depth, see backup/auth.ts):
 *   1. The remote IP must match BACKUP_ALLOW_CIDRS (default: loopback +
 *      RFC1918 + IPv6 ULA — blocks requests from the public internet even
 *      if port 8080 is accidentally exposed).
 *   2. The Authorization header must carry the BACKUP_TOKEN bearer value.
 *
 * These endpoints are implemented as `api.raw` so the handlers can read the
 * peer socket address — Encore's typed APIs do not expose it.
 */

import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { assertBackupRequest } from "./auth";
import { getBackupPool } from "./pool";
import { pgDump, assertPgToolsAvailable } from "./pg-dump";
import {
  isInBackupMode,
  getBackupState,
  setBackupActive,
  setPhase,
  markPgBackupStarted,
  hasPgBackupStarted,
  markFailed,
  clearBackupActive,
  type BackupPhase,
} from "./state";
import { pauseWorkers, resumeWorkers } from "../photo/scan-worker";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "/mnt/backup";
const AUTO_STOP_MS = parseInt(process.env.BACKUP_AUTO_STOP_MS ?? `${60 * 60 * 1000}`, 10);

/**
 * How long pauseWorkers() waits for in-flight scan jobs to drain before
 * continuing anyway. Scan jobs are short-lived so 30 s is plenty; anything
 * still running at that point will happily commit through pg_backup_start
 * (Postgres snapshots the pre-image). Kept short so a loaded server does
 * not stall the backup prep on idle scans.
 */
const DRAIN_TIMEOUT_MS = 30_000;

/**
 * Module-scope handles to the in-flight prep task. They exist for the
 * lifetime of a single backup run and are reset on every /start.
 *
 *   prepTask      — the promise of the full prep pipeline
 *   prepAbort     — signals the pg_dump child to terminate when we need
 *                   to bail out (auto-stop timer fires, or /stop during
 *                   the unlikely case of forced cancellation).
 */
let prepTask: Promise<void> | null = null;
let prepAbort: AbortController | null = null;

interface StartBody {
  /**
   * Short identifier for this backup run, e.g. "daily-20260413-030000".
   * Used for the dump filename and for logs.
   */
  label: string;
}

interface StartResponse {
  label: string;
  startedAt: string;
  dumpFile: string;
  phase: BackupPhase;
}

interface StopResponse {
  ok: true;
  wasActive: boolean;
  label: string | null;
  phase: BackupPhase;
}

interface StatusResponse {
  active: boolean;
  phase: BackupPhase;
  label: string | null;
  startedAt: string | null;
  dumpFile: string | null;
  error: string | null;
}

function validateLabel(label: string): void {
  // Label becomes part of a filename — keep it to a safe charset.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(label)) {
    throw APIError.invalidArgument(
      "label must be 1–64 characters, A–Z a–z 0–9 . _ -",
    );
  }
}

/** Read the full request body as a UTF-8 string, capped at 64 KiB. */
async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      throw APIError.invalidArgument(`request body exceeds ${limit} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody<T>(raw: string): T {
  if (!raw.trim()) {
    throw APIError.invalidArgument("empty request body, expected JSON");
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err: any) {
    throw APIError.invalidArgument(`invalid JSON body: ${err?.message ?? err}`);
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function writeError(res: ServerResponse, err: unknown): void {
  if (err instanceof APIError) {
    const status = API_ERROR_STATUS[err.code] ?? 500;
    writeJson(res, status, {
      code: err.code,
      message: err.message,
      details: (err as any).details ?? null,
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error(err as any, "backup.api.unhandled");
  writeJson(res, 500, { code: "internal", message, details: null });
}

const API_ERROR_STATUS: Record<string, number> = {
  ok: 200,
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 400,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
};

/**
 * Background prep pipeline. Transitions phase draining → dumping → ready.
 * Thrown errors are converted to `failed` by the caller (handlePrepFailure).
 */
async function runPrep(label: string, dumpFile: string, signal: AbortSignal): Promise<void> {
  // 1. Drain scan workers. Bounded wait — if workers are still busy after
  //    DRAIN_TIMEOUT_MS, continue anyway; pg_backup_start handles ongoing
  //    writes correctly (they replay through WAL).
  await pauseWorkers(DRAIN_TIMEOUT_MS);
  if (signal.aborted) throw new Error("prep aborted after drain");

  // 2. Enter Postgres backup mode (forced checkpoint so the subsequent
  //    snapshot captures a consistent state). Cluster-wide.
  setPhase("dumping");
  const pool = getBackupPool();
  await pool.query("SELECT pg_backup_start($1, true)", [label]);
  markPgBackupStarted();
  if (signal.aborted) throw new Error("prep aborted after pg_backup_start");

  // 3. Fast-path pg_dump of the primary `encore` database — allows a
  //    selective restore of the main DB without rolling back the whole
  //    ZFS dataset.
  await pgDump(dumpFile, undefined, signal);

  // 4. Done. The host-side script will now take a ZFS snapshot and call
  //    /internal/backup/stop.
  setPhase("ready");
  log.info("backup.prep.ready", { label, dumpFile });
}

async function handlePrepFailure(label: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  log.error(err as any, "backup.prep.failed", { label, message });
  await bestEffortUnwind(label);
  markFailed(message);
}

/**
 * Run pg_backup_stop() if we ever called pg_backup_start(), and resume the
 * scan workers. Swallows errors — this is the cleanup path.
 */
async function bestEffortUnwind(label: string): Promise<void> {
  if (hasPgBackupStarted()) {
    try {
      const pool = getBackupPool();
      // wait_for_archive=false: don't let a stuck WAL archiver block the
      // unwind. The host script's ZFS snapshot already captured consistent
      // state; WAL archival is orthogonal to our backup flow.
      await pool.query("SELECT pg_backup_stop(false)");
    } catch (err: any) {
      // 55000 = object_not_in_prerequisite_state — already stopped.
      if (err?.code !== "55000") {
        log.warn("backup.unwind.pg_backup_stop.error", { label, message: err?.message });
      }
    }
  }
  resumeWorkers();
}

/**
 * Called by the auto-stop timer if /stop never arrives. Cancels the in-
 * flight prep (if any), unwinds the cluster, and transitions to `failed`.
 */
async function autoStopTimeoutFired(label: string): Promise<void> {
  log.warn("backup.auto-stop", {
    label,
    reason: `no /internal/backup/stop received within ${AUTO_STOP_MS} ms`,
  });

  // Cancel the in-flight prep task if it is still running (kills pg_dump).
  prepAbort?.abort();
  if (prepTask) {
    await prepTask.catch(() => {});
  }

  await bestEffortUnwind(label);
  markFailed(`auto-stop: no /stop within ${AUTO_STOP_MS} ms`);
}

export const startBackup = api.raw(
  { expose: true, method: "POST", path: "/internal/backup/start" },
  async (req, res) => {
    try {
      assertBackupRequest(req);
      const body = parseJsonBody<StartBody>(await readBody(req));
      if (typeof body?.label !== "string") {
        throw APIError.invalidArgument("field `label` is required and must be a string");
      }
      const { label } = body;
      validateLabel(label);

      // If the last run ended in `failed`, clear the residue so the host
      // script can retry without a manual /stop in between.
      if (getBackupState().phase === "failed") {
        log.info("backup.start.clearing-failed-residue", {
          previousLabel: getBackupState().label,
          previousError: getBackupState().error,
        });
        clearBackupActive();
      }

      if (isInBackupMode()) {
        const existing = getBackupState();
        throw APIError.failedPrecondition(
          `backup already running (label=${existing.label}, phase=${existing.phase}, startedAt=${existing.startedAt?.toISOString()})`,
        );
      }

      // Fail fast if the image is missing pg_dump / pg_restore.
      await assertPgToolsAvailable();

      log.info("backup.start", { label });

      const dumpFile = path.join(BACKUP_DIR, `encore-${label}.dump`);

      // Arm the safety timer BEFORE starting prep so a crash in the
      // prep setup itself is still caught.
      const autoStopTimer = setTimeout(() => {
        autoStopTimeoutFired(label).catch((err) =>
          log.error(err, "backup.auto-stop.failed", { label }),
        );
      }, AUTO_STOP_MS);
      autoStopTimer.unref?.();

      setBackupActive(label, autoStopTimer, dumpFile);

      // Kick off the prep task. It owns the phase transitions from here.
      prepAbort = new AbortController();
      prepTask = runPrep(label, dumpFile, prepAbort.signal).catch((err) =>
        handlePrepFailure(label, err),
      );

      const response: StartResponse = {
        label,
        startedAt: getBackupState().startedAt!.toISOString(),
        dumpFile,
        phase: getBackupState().phase,
      };
      writeJson(res, 202, response);
    } catch (err) {
      writeError(res, err);
    }
  },
);

export const stopBackup = api.raw(
  { expose: true, method: "POST", path: "/internal/backup/stop" },
  async (req, res) => {
    try {
      assertBackupRequest(req);

      const current = getBackupState();

      // No active run — idempotent no-op. Host scripts rely on this.
      if (current.phase === "idle") {
        const response: StopResponse = { ok: true, wasActive: false, label: null, phase: "idle" };
        writeJson(res, 200, response);
        return;
      }

      // Previous run failed — /stop acknowledges and resets.
      if (current.phase === "failed") {
        const label = current.label;
        log.info("backup.stop.acknowledge-failed", { label, error: current.error });
        clearBackupActive();
        const response: StopResponse = { ok: true, wasActive: false, label, phase: "idle" };
        writeJson(res, 200, response);
        return;
      }

      // Still preparing — refuse so the host re-polls /status instead of
      // racing against the still-running pg_dump. The safety timer
      // remains the last-resort backstop.
      if (current.phase === "draining" || current.phase === "dumping") {
        throw APIError.failedPrecondition(
          `backup still preparing (phase=${current.phase}); poll /internal/backup/status until phase=ready`,
        );
      }

      // Already stopping — another /stop is in flight.
      if (current.phase === "stopping") {
        throw APIError.failedPrecondition("backup stop already in progress");
      }

      // phase === "ready" — do the normal unwind.
      const label = current.label;
      log.info("backup.stop", { label });
      setPhase("stopping");

      await bestEffortUnwind(label ?? "<unknown>");
      clearBackupActive();

      const response: StopResponse = { ok: true, wasActive: true, label, phase: "idle" };
      writeJson(res, 200, response);
    } catch (err) {
      writeError(res, err);
    }
  },
);

export const backupStatus = api.raw(
  { expose: true, method: "GET", path: "/internal/backup/status" },
  async (req, res) => {
    try {
      assertBackupRequest(req);
      const s = getBackupState();
      const response: StatusResponse = {
        active: s.active,
        phase: s.phase,
        label: s.label,
        startedAt: s.startedAt?.toISOString() ?? null,
        dumpFile: s.dumpFile,
        error: s.error,
      };
      writeJson(res, 200, response);
    } catch (err) {
      writeError(res, err);
    }
  },
);
