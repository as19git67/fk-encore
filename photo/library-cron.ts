/**
 * Daily reconcile job for external photo libraries.
 *
 * The chokidar watcher catches live filesystem events, but events are lost
 * during downtime or when files arrive on a network share that doesn't fire
 * inotify. This job enqueues a scan-with-reconcile job per library so the
 * library-scan worker picks them up and the progress appears in the
 * Scan-Queue status table.
 */

import { api } from "encore.dev/api";
import { listLibraries } from "./libraries.service";
import { enqueueLibraryScan } from "./library-scan-queue";
import { triggerLibraryScanWorker } from "./scan-worker";
import { dailyAtUtc, schedule } from "../lib/local-cron";

console.log("[boot] photo/library-cron.ts: all imports resolved");

export const reconcileAllLibraries = api(
  { expose: false, method: "POST", path: "/internal/libraries/reconcile" },
  async (): Promise<{ libraries: number; queued: number }> => {
    const libs = await listLibraries();
    let queued = 0;
    for (const lib of libs) {
      try {
        const jobId = await enqueueLibraryScan(lib.id, lib.import_mode === "link");
        if (jobId !== null) queued++;
      } catch (err: any) {
        console.error(`[library-cron] enqueue failed for library ${lib.id}:`, err?.message ?? err);
      }
    }
    if (queued > 0) triggerLibraryScanWorker();
    return { libraries: libs.length, queued };
  }
);

// 12:15 Berlin (CEST) / 10:15 UTC — was drifting `every 24h` (relative
// to last container boot); pinned to a fixed UTC time so it lands
// reliably in the 10–13 Uhr batch window.
schedule({
  name: "library-reconcile",
  description: "Enqueue scan jobs for every external photo library",
  service: "photo",
  scheduleLabel: "daily 10:15 UTC",
  nextFire: dailyAtUtc(10, 15),
  run: () => reconcileAllLibraries(),
});
