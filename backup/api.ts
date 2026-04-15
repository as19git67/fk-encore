/**
 * Internal endpoints that coordinate the backup flow.
 *
 *   POST /internal/backup/start
 *     - Enters maintenance mode (catch-all middleware returns 503 for
 *       everything except /internal/backup/*).
 *     - Pauses the photo scan workers.
 *     - Calls pg_backup_start() on the PostgreSQL cluster. This is a
 *       cluster-wide operation that also covers the `embeddings` database
 *       living in the same instance.
 *     - Runs pg_dump for the primary `encore` database to
 *       $BACKUP_DIR/encore-<label>.dump as a fast-path restore option.
 *     - Arms a safety timer that force-stops the flow if /stop is never
 *       called.
 *
 *   POST /internal/backup/stop
 *     - Calls pg_backup_stop(), resumes scan workers, leaves maintenance.
 *     - Idempotent: calling it while idle is a no-op.
 *
 *   GET  /internal/backup/status
 *     - Returns the current state (active, label, startedAt). Used by the
 *       host-side cron script to poll if something went wrong.
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
  clearBackupActive,
} from "./state";
import { pauseWorkers, resumeWorkers } from "../photo/scan-worker";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "/mnt/backup";
const AUTO_STOP_MS = parseInt(process.env.BACKUP_AUTO_STOP_MS ?? `${30 * 60 * 1000}`, 10);

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
}

interface StopResponse {
  ok: true;
  wasActive: boolean;
  label: string | null;
}

interface StatusResponse {
  active: boolean;
  label: string | null;
  startedAt: string | null;
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

/**
 * Map thrown errors to an HTTP response. Centralised so each raw handler
 * only has to `throw APIError.*()` as if it were a typed endpoint.
 */
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

      if (isInBackupMode()) {
        const existing = getBackupState();
        throw APIError.failedPrecondition(
          `backup already running (label=${existing.label}, startedAt=${existing.startedAt?.toISOString()})`,
        );
      }

      // Fail fast if the image is missing pg_dump / pg_restore.
      await assertPgToolsAvailable();

      log.info("backup.start", { label });

      // 1. Stop background writers so no new rows are written after
      //    pg_backup_start holds the WAL. Workers also respect the
      //    maintenance flag, but we stop them explicitly to drain
      //    in-flight jobs cleanly.
      await pauseWorkers();

      // 2. Enter maintenance mode and arm the safety timer. We do this
      //    BEFORE calling pg_backup_start so that if anything below
      //    throws, the maintenance flag is cleared by the error handler.
      const autoStopTimer = setTimeout(() => {
        log.warn("backup.auto-stop", {
          label,
          reason: `no /internal/backup/stop received within ${AUTO_STOP_MS} ms`,
        });
        forceStop().catch((err) =>
          log.error(err, "backup.auto-stop.failed", { label }),
        );
      }, AUTO_STOP_MS);
      autoStopTimer.unref?.();
      setBackupActive(label, autoStopTimer);

      try {
        // 3. Put Postgres into backup mode. This is cluster-wide and also
        //    covers the `embeddings` database.
        //    `fast=true` forces an immediate checkpoint so the subsequent
        //    filesystem snapshot captures a consistent state without
        //    having to wait for the next natural checkpoint.
        const pool = getBackupPool();
        await pool.query("SELECT pg_backup_start($1, true)", [label]);

        // 4. Write a fast-path pg_dump of the primary `encore` database
        //    into $BACKUP_DIR. This is in addition to the filesystem
        //    snapshot that the host-side script takes next, and allows
        //    restoring only the main DB quickly without rolling back the
        //    full ZFS dataset.
        const dumpFile = path.join(BACKUP_DIR, `encore-${label}.dump`);
        await pgDump(dumpFile);

        log.info("backup.start.ready", { label, dumpFile });
        const response: StartResponse = {
          label,
          startedAt: getBackupState().startedAt!.toISOString(),
          dumpFile,
        };
        writeJson(res, 200, response);
      } catch (err) {
        // Unwind on any failure so the system does not get stuck in
        // backup mode.
        await forceStop().catch((cleanupErr) =>
          log.error(cleanupErr, "backup.start.cleanup-failed", { label }),
        );
        throw err;
      }
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

      if (!isInBackupMode()) {
        const response: StopResponse = { ok: true, wasActive: false, label: null };
        writeJson(res, 200, response);
        return;
      }

      const label = getBackupState().label;
      log.info("backup.stop", { label });

      await forceStop();

      const response: StopResponse = { ok: true, wasActive: true, label };
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
        label: s.label,
        startedAt: s.startedAt?.toISOString() ?? null,
      };
      writeJson(res, 200, response);
    } catch (err) {
      writeError(res, err);
    }
  },
);

/**
 * Internal cleanup routine — safe to call multiple times.
 * Runs pg_backup_stop (tolerating the "not in progress" error),
 * resumes workers, and clears the state flag.
 */
async function forceStop(): Promise<void> {
  // pg_backup_stop may throw if we are not in backup mode; that is fine
  // during cleanup paths where we want best-effort.
  try {
    const pool = getBackupPool();
    await pool.query("SELECT pg_backup_stop()");
  } catch (err: any) {
    // 55000 = object_not_in_prerequisite_state — raised when not in backup
    // mode. Treat as already-stopped.
    if (err?.code !== "55000") {
      log.warn("backup.pg_backup_stop.error", { message: err?.message });
    }
  }

  resumeWorkers();
  clearBackupActive();
}
