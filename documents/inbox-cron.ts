/**
 * Hourly reconcile job for the documents inbox.
 *
 * The chokidar watcher in `inbox-watcher.ts` catches live filesystem
 * events, but events are lost when the app is restarted mid-rsync,
 * when a file arrives on a network share that does not fire inotify,
 * or when the watcher is woken before the upstream copy has written
 * any bytes. This cron iterates every supported file currently sitting
 * in `DOCUMENTS_INBOX_DIR` and replays the import — the importer's
 * sha256 dedup makes double-imports a no-op.
 */

import fs from "fs";
import path from "path";
import { api } from "encore.dev/api";
import {
  DOCUMENTS_INBOX_DIR,
  SUPPORTED_EXTENSIONS,
} from "./documents.service";
import { handleAddedFile } from "./inbox-watcher";
import { everyMs, schedule } from "../lib/local-cron";

interface ReconcileResult {
  scanned: number;
  attempted: number;
}

/**
 * Every supported file below `dir`, depth first. Hidden entries are
 * skipped like the watcher skips them; a directory that vanishes while
 * we read it is treated as empty.
 */
async function collectSupportedFiles(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    console.error(
      `[documents.inbox-cron] readdir ${dir} failed: ${err?.message ?? err}`,
    );
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSupportedFiles(abs)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    files.push(abs);
  }
  return files;
}

export const reconcileInbox = api(
  { expose: false, method: "POST", path: "/internal/documents/inbox-reconcile" },
  async (): Promise<ReconcileResult> => {
    if (!fs.existsSync(DOCUMENTS_INBOX_DIR)) {
      return { scanned: 0, attempted: 0 };
    }

    // Walk the whole tree: user folders (`<login-slug>/…`) and any
    // subfolders a scanner put files in are inbox content too.
    const files = await collectSupportedFiles(DOCUMENTS_INBOX_DIR);

    let attempted = 0;
    for (const abs of files) {
      attempted++;
      // handleAddedFile already swallows duplicate / empty errors and
      // logs the rest, so we don't need a try/catch wrapper here.
      await handleAddedFile(abs);
    }

    return { scanned: files.length, attempted };
  },
);

schedule({
  name: "documents-inbox-reconcile",
  description: "Replay inbox files the live watcher missed",
  service: "documents",
  scheduleLabel: "every 1h",
  nextFire: everyMs(60 * 60_000),
  run: () => reconcileInbox(),
});
