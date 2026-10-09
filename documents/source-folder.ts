/**
 * The folder a document came from (#1477).
 *
 * Before the import, the household's folder tree *was* the context: the
 * policy, its terms and conditions and every later letter sat side by side.
 * `importDocumentFromPath` used to keep only the file name, so that context
 * was lost the moment a file left the inbox. `documents.source_folder` keeps
 * it as a plain relative path — data about the document, never a filing
 * location; `disk_path` alone says where the file lives.
 *
 * Shape: `/`-separated, no leading or trailing slash, no `.` or `..`
 * segments, `null` for a file that arrived on its own at the root.
 *
 * The backfill walks the old folder tree (mounted read-only on the server),
 * hashes every supported file and writes the folder onto the row whose
 * `sha256` matches — the same content hash `fsck.ts` relies on, so a file
 * that was renamed on the way in still finds its row. Dry run by default:
 * the report is what the admin checks before `apply: true` writes anything.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { eq, inArray } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { documents } from "../db/schema";
import { SUPPORTED_EXTENSIONS } from "./documents.service";

console.log("[boot] documents/source-folder.ts: all imports resolved");

/** Longest folder path stored; anything beyond is a mistake, not a folder. */
export const SOURCE_FOLDER_MAX_LENGTH = 1024;

/**
 * Bring a raw folder string into the stored shape, or `null` when nothing
 * sensible is left. Accepts both separators (a browser on Windows reports
 * `webkitRelativePath` with `/`, a copied path may carry `\`), drops empty,
 * `.` and `..` segments rather than rejecting the whole path — the folder is
 * a hint about origin, not a path that is ever opened.
 */
export function normalizeSourceFolder(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const segments = raw
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  if (segments.length === 0) return null;
  const joined = segments.join("/");
  return joined.length > SOURCE_FOLDER_MAX_LENGTH ? null : joined;
}

/**
 * The folder of `filePath` relative to `rootDir`, in stored shape. A file
 * directly in the root yields `null`; a file outside the root (which the
 * inbox watcher never reports, but a caller might) yields `null` too rather
 * than a path that climbs out of the root.
 */
export function sourceFolderFor(rootDir: string, filePath: string): string | null {
  const rel = path.relative(path.resolve(rootDir), path.dirname(path.resolve(filePath)));
  if (rel === "" || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return normalizeSourceFolder(rel.split(path.sep).join("/"));
}

/** `folder` itself and every folder below it, for the list filter. */
export function sourceFolderPrefixPattern(folder: string): string {
  const escaped = folder.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `${escaped}/%`;
}

/** Streaming sha256 of a file — the dedup key every `documents` row carries. */
export async function hashFile(absPath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

// ─── Backfill ───────────────────────────────────────────────────────────────

/** Upper bound on files hashed in one run — a runaway guard, not a quota. */
const BACKFILL_MAX_FILES = parseInt(
  process.env.DOCUMENTS_SOURCE_FOLDER_BACKFILL_MAX_FILES ?? "50000",
  10,
);
/** Entries listed per report section so a huge tree cannot flood the response. */
const REPORT_LIST_CAP = 500;

export interface SourceFolderBackfillRequest {
  /** Absolute path of the old folder tree on the server. */
  root: string;
  /** When true, write matched folders; otherwise only report (the default). */
  apply?: boolean;
}

export interface SourceFolderBackfillMatch {
  document_id: number;
  /** The folder that would be (or was) written. */
  source_folder: string | null;
  /** The folder the row carried before. */
  previous: string | null;
}

export interface SourceFolderBackfillResponse {
  dry_run: boolean;
  /** Supported files found under `root`. */
  files_scanned: number;
  /** Files whose content matched a document row. */
  matched: number;
  /** Matched rows whose folder actually changed (written when `apply`). */
  updated: number;
  /** Files whose content matched no row — listed relative to `root`, capped. */
  unmatched_files: string[];
  unmatched_files_total: number;
  /** The same content found in two folders — left alone, listed, capped. */
  ambiguous_files: string[];
  ambiguous_files_total: number;
  /** Document rows no file under `root` accounts for. */
  unmatched_rows_total: number;
  /** The matches themselves, capped. */
  matches: SourceFolderBackfillMatch[];
  /** True when the walk stopped at the file cap and the report is partial. */
  truncated: boolean;
}

function isSupportedFile(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Walk `root` and return every supported regular file with its folder in
 * stored shape. Dot-entries are skipped (`.DS_Store`, `.sync`), as are
 * symbolic links, so a link into the live documents volume cannot pull its
 * files into the report.
 */
export async function walkSourceTree(
  root: string,
  maxFiles = BACKFILL_MAX_FILES,
): Promise<{ files: Array<{ abs: string; rel: string; folder: string | null }>; truncated: boolean }> {
  const files: Array<{ abs: string; rel: string; folder: string | null }> = [];
  const stack = [root];
  let truncated = false;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile() || !isSupportedFile(entry.name)) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return { files, truncated };
      }
      files.push({
        abs,
        rel: path.relative(root, abs).split(path.sep).join("/"),
        folder: sourceFolderFor(root, abs),
      });
    }
  }
  return { files, truncated };
}

/**
 * The backfill proper, separated from the endpoint so a test can run it
 * against a temp directory without an HTTP layer.
 */
export async function backfillSourceFolders(
  root: string,
  apply: boolean,
): Promise<SourceFolderBackfillResponse> {
  const { files, truncated } = await walkSourceTree(root);

  // sha256 → folder. The same bytes in two folders cannot be assigned, so the
  // second sighting marks the digest ambiguous and both files are reported.
  const byDigest = new Map<string, { folder: string | null; rel: string }>();
  const ambiguous = new Map<string, string[]>();
  for (const f of files) {
    const digest = await hashFile(f.abs);
    const seen = byDigest.get(digest);
    if (seen && seen.folder !== f.folder) {
      const list = ambiguous.get(digest) ?? [seen.rel];
      list.push(f.rel);
      ambiguous.set(digest, list);
      continue;
    }
    if (!seen) byDigest.set(digest, { folder: f.folder, rel: f.rel });
  }
  for (const digest of ambiguous.keys()) byDigest.delete(digest);

  const matches: SourceFolderBackfillMatch[] = [];
  const matchedDigests = new Set<string>();
  const digests = [...byDigest.keys()];
  const CHUNK = 500;
  for (let i = 0; i < digests.length; i += CHUNK) {
    const rows = await dbAll<{ id: number; sha256: string; source_folder: string | null }>(
      db
        .select({ id: documents.id, sha256: documents.sha256, source_folder: documents.source_folder })
        .from(documents)
        .where(inArray(documents.sha256, digests.slice(i, i + CHUNK))),
    );
    for (const row of rows) {
      const hit = byDigest.get(row.sha256);
      if (!hit) continue;
      matchedDigests.add(row.sha256);
      matches.push({ document_id: row.id, source_folder: hit.folder, previous: row.source_folder });
    }
  }

  const changed = matches.filter((m) => m.source_folder !== m.previous);
  if (apply) {
    for (const m of changed) {
      await db
        .update(documents)
        .set({ source_folder: m.source_folder })
        .where(eq(documents.id, m.document_id));
    }
  }

  const unmatchedFiles = digests
    .filter((d) => !matchedDigests.has(d))
    .map((d) => byDigest.get(d)!.rel)
    .sort();
  const ambiguousFiles = [...ambiguous.values()].flat().sort();
  const totalRows = await dbAll<{ n: number }>(
    db.select({ n: documents.id }).from(documents),
  );

  return {
    dry_run: !apply,
    files_scanned: files.length,
    matched: matches.length,
    updated: changed.length,
    unmatched_files: unmatchedFiles.slice(0, REPORT_LIST_CAP),
    unmatched_files_total: unmatchedFiles.length,
    ambiguous_files: ambiguousFiles.slice(0, REPORT_LIST_CAP),
    ambiguous_files_total: ambiguousFiles.length,
    unmatched_rows_total: totalRows.length - matches.length,
    matches: matches.slice(0, REPORT_LIST_CAP),
    truncated,
  };
}

/**
 * `POST /documents/source-folder/backfill` — admin only (`data.manage`),
 * because it walks an arbitrary server path and writes across every owner's
 * documents; the plain `documents.edit` holder sees only their own.
 */
export const sourceFolderBackfill = api(
  { expose: true, method: "POST", path: "/documents/source-folder/backfill", auth: true },
  async (req: SourceFolderBackfillRequest): Promise<SourceFolderBackfillResponse> => {
    const authData = getAuthData();
    if (!authData) throw APIError.unauthenticated("Unauthorized");
    requirePermission(authData, "module.documents");
    requirePermission(authData, "data.manage");

    const root = path.resolve((req.root ?? "").trim());
    if (!req.root || root === path.parse(root).root) {
      throw APIError.invalidArgument("root must name a directory below the filesystem root");
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(root);
    } catch {
      throw APIError.notFound(`root does not exist: ${root}`);
    }
    if (!stat.isDirectory()) throw APIError.invalidArgument(`root is not a directory: ${root}`);

    return backfillSourceFolders(root, req.apply === true);
  },
);
