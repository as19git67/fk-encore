/**
 * Hourly reconcile job for external photo libraries.
 *
 * The chokidar watcher catches live filesystem events, but events are lost
 * during downtime or when files arrive on a network share that doesn't fire
 * inotify. This job iterates every link-mode library, drops rows whose
 * `external_path` no longer exists, and runs a fresh scan to import anything
 * new. Move-mode libraries also get a re-scan so files dropped while the
 * service was down still get picked up.
 */

import { CronJob } from "encore.dev/cron";
import { api } from "encore.dev/api";
import { listLibraries, reconcileLibrary, scanLibrary } from "./libraries.service";

export const reconcileAllLibraries = api(
  { expose: false, method: "POST", path: "/internal/libraries/reconcile" },
  async (): Promise<{ libraries: number; removed: number; imported: number }> => {
    const libs = await listLibraries();
    let removed = 0;
    let imported = 0;
    for (const lib of libs) {
      try {
        if (lib.import_mode === "link") {
          const r = await reconcileLibrary(lib.id);
          removed += r.removed;
        }
        const s = await scanLibrary(lib.id);
        imported += s.imported;
      } catch (err: any) {
        console.error(`[library-cron] reconcile failed for library ${lib.id}:`, err?.message ?? err);
      }
    }
    return { libraries: libs.length, removed, imported };
  }
);

const _ = new CronJob("library-reconcile", {
  title: "Reconcile external photo libraries",
  every: "1h",
  endpoint: reconcileAllLibraries,
});
