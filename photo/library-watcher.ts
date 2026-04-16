/**
 * Filesystem watcher for external photo libraries.
 *
 * One chokidar instance per library with `auto_import = true`. Newly-added
 * supported image files are imported through `libraries.service.importFile`;
 * deletions remove the matching link-mode photo row (move-mode files live
 * under UPLOAD_DIR and are not affected by external mutations).
 *
 * Watchers are started lazily on first use and rebuilt whenever a library is
 * created/updated/deleted via the API.
 */

import chokidar, { type FSWatcher } from "chokidar";
import path from "path";
import {
  SUPPORTED_EXTENSIONS,
} from "./photo.service";
import {
  importFile,
  handleExternalUnlink,
  listLibraries,
  type PhotoLibrary,
} from "./libraries.service";

const watchers = new Map<number, FSWatcher>();

function isSupported(file: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export async function startWatcher(library: PhotoLibrary): Promise<void> {
  if (watchers.has(library.id)) return;

  const watcher = chokidar.watch(library.path, {
    ignored: (p, stats) => {
      const base = path.basename(p);
      if (base.startsWith(".")) return true;
      // Only watch directories and supported files. Returning true for an
      // unsupported file means chokidar will skip it; for directories we
      // recurse normally.
      if (stats?.isFile()) return !isSupported(p);
      return false;
    },
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  });

  watcher.on("add", async (file) => {
    try {
      await importFile(library, file);
    } catch (err: any) {
      console.error(`[library-watcher ${library.id}] import failed for ${file}:`, err?.message ?? err);
    }
  });

  if (library.import_mode === "link") {
    watcher.on("unlink", async (file) => {
      try {
        await handleExternalUnlink(file);
      } catch (err: any) {
        console.error(`[library-watcher ${library.id}] unlink handler failed for ${file}:`, err?.message ?? err);
      }
    });
  }

  watcher.on("error", (err) => {
    console.error(`[library-watcher ${library.id}] error:`, err);
  });

  watchers.set(library.id, watcher);
  console.log(`[library-watcher] watching library ${library.id} at ${library.path}`);
}

export async function stopWatcher(libraryId: number): Promise<void> {
  const watcher = watchers.get(libraryId);
  if (!watcher) return;
  await watcher.close();
  watchers.delete(libraryId);
  console.log(`[library-watcher] stopped library ${libraryId}`);
}

export async function stopAllWatchers(): Promise<void> {
  for (const id of [...watchers.keys()]) await stopWatcher(id);
}

/** Boot watchers for every library with auto_import = true. */
export async function startConfiguredWatchers(): Promise<void> {
  const all = await listLibraries();
  for (const lib of all) {
    if (lib.auto_import) {
      await startWatcher(lib).catch((err) =>
        console.error(`[library-watcher] failed to start ${lib.id}:`, err)
      );
    }
  }
}
