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

export const reconcileInbox = api(
  { expose: false, method: "POST", path: "/internal/documents/inbox-reconcile" },
  async (): Promise<ReconcileResult> => {
    if (!fs.existsSync(DOCUMENTS_INBOX_DIR)) {
      return { scanned: 0, attempted: 0 };
    }

    let entries: string[];
    try {
      entries = await fs.promises.readdir(DOCUMENTS_INBOX_DIR);
    } catch (err: any) {
      console.error(
        `[documents.inbox-cron] readdir ${DOCUMENTS_INBOX_DIR} failed: ${err?.message ?? err}`,
      );
      return { scanned: 0, attempted: 0 };
    }

    let attempted = 0;
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const ext = path.extname(entry).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      const abs = path.join(DOCUMENTS_INBOX_DIR, entry);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(abs);
      } catch {
        // File vanished between readdir and stat — likely the live
        // watcher just moved it. Nothing to do.
        continue;
      }
      if (!stat.isFile()) continue;

      attempted++;
      // handleAddedFile already swallows duplicate / empty errors and
      // logs the rest, so we don't need a try/catch wrapper here.
      await handleAddedFile(abs);
    }

    return { scanned: entries.length, attempted };
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
