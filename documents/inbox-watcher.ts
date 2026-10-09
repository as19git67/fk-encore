/**
 * Filesystem watcher for the document inbox.
 *
 * A single chokidar instance watches `DOCUMENTS_INBOX_DIR`. New PDFs
 * that stay stable for `stabilityThreshold` are imported through the
 * shared `importDocumentFromPath` helper — identical to what the UI
 * upload endpoint does, minus the HTTP layer. The watcher is a no-op
 * if the inbox directory doesn't exist; that lets the feature stay
 * opt-in without forcing admins who do not use it to create an empty
 * directory.
 *
 * Who owns an imported file is decided by where it lands:
 *
 *   documents-inbox/<login-slug>/...   → the user whose login slug
 *                                        (see `slugifyUserLogin`) names
 *                                        the first folder
 *   documents-inbox/...                → the fallback owner
 *                                        (`DOCUMENTS_INBOX_USER_EMAIL`,
 *                                        else the first Admin)
 *
 * The owner's "default group for new documents" preference then decides
 * whether the document is private or shared, exactly as for a UI upload.
 * A first folder that matches no user is not an owner folder: the file
 * goes to the fallback owner and the whole relative path stays its
 * source folder. The owner lookup is cached per folder name and reset
 * when the watcher stops.
 *
 * Env knobs:
 *   DOCUMENTS_INBOX_DIR            default: uploads/documents-inbox
 *   DOCUMENTS_INBOX_USER_EMAIL     fallback owner for files outside a
 *                                  user folder (falls back to the first
 *                                  Admin)
 *   DOCUMENTS_INBOX_STABILITY_MS   await-write-finish window, default 10000
 */

import fs from "fs";
import path from "path";
import chokidar, { type FSWatcher } from "chokidar";
import { asc, eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { roles, userRoles, users } from "../db/schema";
import {
  DOCUMENTS_INBOX_DIR,
  SUPPORTED_EXTENSIONS,
  slugifyUserLogin,
} from "./documents.service";
import {
  DuplicateDocumentError,
  EmptySourceFileError,
  importDocumentFromPath,
} from "./import";
import { triggerWorkers } from "./scan-worker";
import { sourceFolderFor } from "./source-folder";

let watcher: FSWatcher | null = null;
/** Fallback owner for files outside a user folder; `undefined` = not yet resolved. */
let cachedFallbackOwnerId: number | null | undefined;
/** First inbox folder → user id, or null when the folder names no user. */
const cachedFolderOwners = new Map<string, number | null>();

function isSupported(file: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Resolve the user that owns inbox files outside any user folder.
 * Priority:
 *   1. `DOCUMENTS_INBOX_USER_EMAIL` env var → user must exist.
 *   2. The first user (by id) holding the `Admin` role.
 *   3. null → import is skipped with a warning.
 */
export async function resolveInboxOwnerId(): Promise<number | null> {
  const email = (process.env.DOCUMENTS_INBOX_USER_EMAIL ?? "").trim().toLowerCase();
  if (email) {
    const row = await dbFirst<{ id: number }>(
      db.select({ id: users.id }).from(users).where(eq(users.email, email)),
    );
    if (row) return row.id;
    console.warn(
      `[documents.inbox-watcher] DOCUMENTS_INBOX_USER_EMAIL=${email} not found — falling back to Admin`,
    );
  }

  const admin = await dbFirst<{ id: number }>(
    db
      .select({ id: users.id })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.user_id, users.id))
      .innerJoin(roles, eq(roles.id, userRoles.role_id))
      .where(eq(roles.name, "Admin"))
      .orderBy(asc(users.id)),
  );
  return admin?.id ?? null;
}

/**
 * The user whose login slug is `folder`, or null when no user has that
 * slug. Slugs are derived from the e-mail's local part and may collide
 * (`anna@a.test` and `anna@b.test` are both `anna`); the first user by
 * id wins, matching the fallback's tie-break.
 */
export async function resolveInboxFolderOwnerId(folder: string): Promise<number | null> {
  const rows = await dbAll<{ id: number; email: string }>(
    db.select({ id: users.id, email: users.email }).from(users).orderBy(asc(users.id)),
  );
  for (const row of rows) {
    if (slugifyUserLogin(row.email, row.id) === folder) return row.id;
  }
  return null;
}

/** The first path segment of `file` below the inbox root, or null at the root. */
export function inboxFolderOf(rootDir: string, file: string): string | null {
  const rel = path.relative(path.resolve(rootDir), path.resolve(file));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const segments = rel.split(path.sep);
  return segments.length > 1 ? segments[0]! : null;
}

export interface ResolvedInboxOwner {
  userId: number;
  /** The directory whose relative path becomes the document's source folder. */
  sourceRoot: string;
}

/**
 * Decide who owns `file` and which directory its source folder is
 * measured from. A user folder is stripped from the source folder: the
 * folder names the owner, it is not where the document came from.
 */
export async function resolveInboxOwnerFor(file: string): Promise<ResolvedInboxOwner | null> {
  const folder = inboxFolderOf(DOCUMENTS_INBOX_DIR, file);
  if (folder != null) {
    let ownerId = cachedFolderOwners.get(folder);
    if (ownerId === undefined) {
      ownerId = await resolveInboxFolderOwnerId(folder);
      cachedFolderOwners.set(folder, ownerId);
      if (ownerId == null) {
        console.warn(
          `[documents.inbox-watcher] folder ${folder} names no user — importing for the fallback owner`,
        );
      }
    }
    if (ownerId != null) {
      return { userId: ownerId, sourceRoot: path.join(DOCUMENTS_INBOX_DIR, folder) };
    }
  }

  if (cachedFallbackOwnerId === undefined) {
    cachedFallbackOwnerId = await resolveInboxOwnerId();
  }
  if (cachedFallbackOwnerId == null) return null;
  return { userId: cachedFallbackOwnerId, sourceRoot: DOCUMENTS_INBOX_DIR };
}

/** For tests: reset the cached owners so they are re-queried. */
export function _resetInboxOwnerCache(): void {
  cachedFallbackOwnerId = undefined;
  cachedFolderOwners.clear();
}

/**
 * Import a single inbox file. Exported so the hourly reconcile cron
 * (`inbox-cron.ts`) can replay add events for files the live watcher
 * missed (downtime, network share without inotify, watcher fired while
 * the upstream copy was still streaming).
 */
export async function handleAddedFile(file: string): Promise<void> {
  if (!isSupported(file)) return;
  const owner = await resolveInboxOwnerFor(file);
  if (owner === null) {
    console.warn(
      `[documents.inbox-watcher] no owning user available — skipping ${path.basename(file)}`,
    );
    return;
  }

  try {
    const imported = await importDocumentFromPath({
      userId: owner.userId,
      sourcePath: file,
      originalFilename: path.basename(file),
      mimeType: "application/pdf",
      // `Versicherungen/Hausrat/police.pdf` → "Versicherungen/Hausrat": the
      // subfolder the scanner or a copy put the file in is the one context
      // the import would otherwise throw away (#1477). A user folder is
      // not part of it.
      sourceFolder: sourceFolderFor(owner.sourceRoot, file),
    });
    console.log(
      `[documents.inbox-watcher] imported ${path.basename(file)} → document ${imported.id}`,
    );
    triggerWorkers();
  } catch (err: any) {
    if (err instanceof DuplicateDocumentError) {
      console.log(
        `[documents.inbox-watcher] duplicate ignored: ${path.basename(file)} (matches document ${err.existingId})`,
      );
      return;
    }
    if (err instanceof EmptySourceFileError) {
      // Watcher fired before the upstream copy wrote any bytes. Leave
      // the file in place — the reconcile cron (or the next stable
      // rewrite event) will pick it up once it has content.
      console.log(
        `[documents.inbox-watcher] still empty, deferring: ${path.basename(file)}`,
      );
      return;
    }
    console.error(
      `[documents.inbox-watcher] failed to import ${path.basename(file)}: ${err?.message ?? err}`,
    );
  }
}

export async function startInboxWatcher(): Promise<void> {
  if (watcher) return;

  // The inbox is opt-in — if the directory does not exist, stay out
  // of the admin's way. A missing path avoids a noisy chokidar error.
  if (!fs.existsSync(DOCUMENTS_INBOX_DIR)) {
    console.log(
      `[documents.inbox-watcher] inbox ${DOCUMENTS_INBOX_DIR} does not exist — watcher disabled`,
    );
    return;
  }

  const stabilityMs = parseInt(
    process.env.DOCUMENTS_INBOX_STABILITY_MS ?? "10000",
    10,
  );

  watcher = chokidar.watch(DOCUMENTS_INBOX_DIR, {
    ignored: (p, stats) => {
      const base = path.basename(p);
      if (base.startsWith(".")) return true;
      if (stats?.isFile()) return !isSupported(p);
      return false;
    },
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: stabilityMs, pollInterval: 500 },
  });

  watcher.on("add", (file) => {
    handleAddedFile(file).catch((err) =>
      console.error(`[documents.inbox-watcher] add handler crashed for ${file}:`, err),
    );
  });
  watcher.on("error", (err) => {
    console.error("[documents.inbox-watcher] chokidar error:", err);
  });

  console.log(`[documents.inbox-watcher] watching ${DOCUMENTS_INBOX_DIR} (stability=${stabilityMs}ms)`);
}

export async function stopInboxWatcher(): Promise<void> {
  if (!watcher) return;
  await watcher.close();
  watcher = null;
  _resetInboxOwnerCache();
  console.log("[documents.inbox-watcher] stopped");
}
