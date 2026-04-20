/**
 * Hourly reconcile job for external photo libraries.
 *
 * The chokidar watcher catches live filesystem events, but events are lost
 * during downtime or when files arrive on a network share that doesn't fire
 * inotify. This job enqueues a scan-with-reconcile job per library so the
 * library-scan worker picks them up and the progress appears in the
 * Scan-Queue status table.
 */

import { CronJob } from "encore.dev/cron";
import { api } from "encore.dev/api";
import { listLibraries } from "./libraries.service";
import { enqueueLibraryScan } from "./library-scan-queue";
import { triggerLibraryScanWorker } from "./scan-worker";

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

const _ = new CronJob("library-reconcile", {
  title: "Reconcile external photo libraries",
  every: "1h",
  endpoint: reconcileAllLibraries,
});
