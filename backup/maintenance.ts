/**
 * Maintenance-mode middleware.
 *
 * Short-circuits requests to data-facing endpoints while a backup is in
 * progress. The /internal/backup/* endpoints are served by the `backup`
 * service which deliberately does NOT install this middleware, so that the
 * host-side cron can always reach /internal/backup/stop even while the flag
 * is set.
 *
 * Raw endpoints (photo upload, static frontend, healthz) perform their own
 * opt-out by calling `isInBackupMode()` at the top of the handler where a
 * different response shape is required. Typed endpoints get a 503 via
 * APIError.unavailable().
 */

import { middleware, APIError } from "encore.dev/api";
import { isInBackupMode } from "./state";

console.log("[boot] backup/maintenance.ts: all imports resolved");

export const maintenanceMiddleware = middleware({}, async (req, next) => {
  if (isInBackupMode()) {
    throw APIError.unavailable(
      "Backup in progress — the service is temporarily read-only. Please retry in a few minutes.",
    );
  }
  return next(req);
});

/** Minimal HTML page shown when a browser hits a raw endpoint during backup. */
export const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <title>Wartung läuft — F4mil</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1f2937; }
      h1 { font-size: 1.5rem; margin-bottom: 0.75rem; }
      p  { line-height: 1.5; color: #4b5563; }
      code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 0.25rem; font-size: 0.9em; }
    </style>
  </head>
  <body>
    <h1>Wartung läuft</h1>
    <p>Es läuft gerade ein Backup. Der Dienst ist für wenige Minuten nicht erreichbar und antwortet mit <code>503 Service Unavailable</code>.</p>
    <p>Bitte in Kürze erneut versuchen.</p>
  </body>
</html>
`;

/**
 * Helper for raw endpoints that want to serve the maintenance page instead
 * of running their normal handler while backup mode is active.
 *
 * Returns `true` if the response was written and the caller should return
 * immediately; `false` if the handler should proceed normally.
 */
export function writeMaintenanceResponseIfActive(res: {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
}): boolean {
  if (!isInBackupMode()) return false;
  res.statusCode = 503;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Retry-After", "60");
  res.end(MAINTENANCE_HTML);
  return true;
}
