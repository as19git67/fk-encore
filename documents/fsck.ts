/**
 * Documents storage consistency check ("fsck") with auto-heal.
 *
 * Every `documents` row carries a `disk_path` that must point at an
 * existing file. Historically a race between a relocate and a concurrent
 * relocate/replace could leave a row pointing at a path where no file was
 * ever written, while the real bytes sat at a different, now-unreferenced
 * ("orphan") location — surfacing only later as an `ENOENT` when a backup
 * or reprocess opened the file. The write path is now serialized per
 * document (see document-lock.ts) and refuses to record a phantom path,
 * but this job is the safety net that:
 *
 *   1. detects any row whose `disk_path` is missing on disk, and
 *   2. heals it by locating an orphan file whose *content* sha256 matches
 *      the row's `sha256`, pointing `disk_path` back at it, and relocating
 *      it to its canonical speaking name.
 *
 * Content hashing (not filename matching) is what makes the heal reliable:
 * a document's on-disk name can lag its metadata (an old category/date or a
 * pre-`replace-file`/`unlock` hash suffix), but its bytes always hash to the
 * row's current `sha256`.
 *
 * Cost: the tree is only walked when at least one row is broken, and only
 * orphan files (those not referenced by any existing `disk_path`) are
 * hashed — in a healthy store that is zero, so the daily run is a cheap
 * `stat` per row.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { api } from "encore.dev/api";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { documents } from "../db/schema";
import {
  DOCUMENTS_DIR,
  STEUER_SEGMENT,
} from "./documents.service";
import { DOCUMENTS_OCR_DIR } from "./ocr-pdf";
import { DOCUMENTS_THUMBS_DIR } from "./thumbnail";
import { relocateDocument } from "./relocate";
import { withDocumentLock } from "./document-lock";
import { dailyAtUtc, schedule } from "../lib/local-cron";

console.log("[boot] documents/fsck.ts: all imports resolved");

/**
 * Directory names that never hold canonical document files and must be
 * skipped when hunting for orphans:
 *   - `_steuer`   holds tax-view hardlinks (same inode as a canonical file),
 *   - `_thumbs`   holds `<id>.webp` previews,
 *   - `_ocr`      holds `<id>.pdf` searchable sidecars.
 * `_inbox` is intentionally NOT skipped — unclassified documents legitimately
 * live there and are referenced by `disk_path`, so an inbox file with no
 * referencing row is a genuine orphan.
 */
const SKIP_DIR_NAMES = new Set([STEUER_SEGMENT, "_thumbs", "_ocr"]);

/** Upper bound on orphan files hashed in a single run — a runaway guard. */
const MAX_ORPHAN_HASHES = parseInt(
  process.env.DOCUMENTS_FSCK_MAX_ORPHAN_HASHES ?? "5000",
  10,
);

export interface DocumentsFsckRequest {
  /** When true, only report — never move files or update rows. */
  dry_run?: boolean;
}

export interface DocumentsFsckResponse {
  /** Total document rows examined. */
  checked: number;
  /** Rows whose `disk_path` existed on disk. */
  ok: number;
  /** Rows whose `disk_path` was missing on disk. */
  missing: number;
  /** Missing rows healed by re-pointing at a content-matched orphan. */
  healed: number;
  /** Missing rows for which no content-matching file could be found. */
  unrecoverable: number;
  /** Ids of the unrecoverable rows (bytes truly lost). */
  unrecoverable_ids: number[];
  /** Orphan files hashed while searching for matches. */
  orphans_scanned: number;
}

interface DocRow {
  id: number;
  disk_path: string;
  sha256: string;
}

export const runDocumentsFsck = api(
  { expose: false, method: "POST", path: "/internal/documents/fsck" },
  async (req: DocumentsFsckRequest): Promise<DocumentsFsckResponse> => {
    const dryRun = req.dry_run ?? false;

    const rows = await dbAll<DocRow>(
      db
        .select({
          id: documents.id,
          disk_path: documents.disk_path,
          sha256: documents.sha256,
        })
        .from(documents),
    );

    const broken: DocRow[] = [];
    const claimed = new Set<string>();
    let ok = 0;
    for (const r of rows) {
      const abs = path.resolve(r.disk_path);
      claimed.add(abs);
      if (fs.existsSync(abs)) ok += 1;
      else broken.push(r);
    }

    const result: DocumentsFsckResponse = {
      checked: rows.length,
      ok,
      missing: broken.length,
      healed: 0,
      unrecoverable: 0,
      unrecoverable_ids: [],
      orphans_scanned: 0,
    };

    if (broken.length === 0) {
      console.log(`[documents.fsck] all ${rows.length} document files present`);
      return result;
    }

    console.warn(
      `[documents.fsck] ${broken.length} document(s) with a missing file — scanning for orphans to heal`,
    );

    // Build a sha256 → orphan-path map by hashing every real file under
    // DOCUMENTS_DIR that is NOT referenced by an existing disk_path.
    const orphanBySha = await indexOrphans(claimed, result);

    for (const r of broken) {
      const found = orphanBySha.get(r.sha256);
      if (!found) {
        result.unrecoverable += 1;
        result.unrecoverable_ids.push(r.id);
        console.error(
          `[documents.fsck] document ${r.id}: no file matching sha256=${r.sha256.slice(0, 12)}… — bytes appear lost (disk_path=${r.disk_path})`,
        );
        continue;
      }

      if (dryRun) {
        result.healed += 1; // report what *would* be healed
        console.log(
          `[documents.fsck] document ${r.id}: would heal from orphan ${found}`,
        );
        continue;
      }

      try {
        // Point the row at the recovered file (locked against writers),
        // then relocate to move it to its canonical speaking name.
        await withDocumentLock(r.id, async () => {
          await db
            .update(documents)
            .set({ disk_path: found })
            .where(eq(documents.id, r.id));
        });
        await relocateDocument(r.id);
        result.healed += 1;
        console.log(
          `[documents.fsck] document ${r.id}: healed from orphan ${found}`,
        );
        // A path can only heal one broken row; drop it so a duplicate
        // sha (shouldn't happen — sha256 is unique) can't double-claim it.
        orphanBySha.delete(r.sha256);
      } catch (err) {
        result.unrecoverable += 1;
        result.unrecoverable_ids.push(r.id);
        console.error(
          `[documents.fsck] document ${r.id}: heal failed: ${(err as Error).message}`,
        );
      }
    }

    console.log(
      `[documents.fsck] done — checked=${result.checked} ok=${result.ok} ` +
        `missing=${result.missing} healed=${result.healed} ` +
        `unrecoverable=${result.unrecoverable} orphans=${result.orphans_scanned}`,
    );
    return result;
  },
);

/**
 * Walk DOCUMENTS_DIR and hash every file not referenced by an existing
 * `disk_path`, returning a sha256 → absolute-path index. Derived-artifact
 * directories (`_steuer`, `_thumbs`, `_ocr`) are skipped. Bounded by
 * `MAX_ORPHAN_HASHES` to cap the cost of a pathological tree.
 */
async function indexOrphans(
  claimed: Set<string>,
  result: DocumentsFsckResponse,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  // Extra guard for the case where the OCR/thumb caches were relocated
  // (via env) to a custom path that still sits inside DOCUMENTS_DIR.
  const skipRoots = new Set(
    [DOCUMENTS_OCR_DIR, DOCUMENTS_THUMBS_DIR].map((p) => path.resolve(p)),
  );

  const stack: string[] = [DOCUMENTS_DIR];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (skipRoots.has(path.resolve(abs))) continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const resolved = path.resolve(abs);
      if (claimed.has(resolved)) continue; // referenced → not an orphan
      if (result.orphans_scanned >= MAX_ORPHAN_HASHES) {
        console.warn(
          `[documents.fsck] orphan-hash cap (${MAX_ORPHAN_HASHES}) reached — some files not indexed`,
        );
        return index;
      }
      result.orphans_scanned += 1;
      try {
        const sha = await hashFile(resolved);
        // First match wins; sha256 is a unique key so collisions are noise.
        if (!index.has(sha)) index.set(sha, resolved);
      } catch {
        // Unreadable/vanished file — ignore.
      }
    }
  }
  return index;
}

function hashFile(absPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

schedule({
  name: "documents-fsck",
  description: "Verify document files exist and heal rows pointing at missing files",
  service: "documents",
  scheduleLabel: "daily 03:30 UTC",
  nextFire: dailyAtUtc(3, 30),
  run: () => runDocumentsFsck({}),
});
