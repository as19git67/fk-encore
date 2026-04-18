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
 * The owning user is picked once at boot and cached — the inbox is a
 * single-tenant integration point (typically the household scanner).
 *
 * Env knobs:
 *   DOCUMENTS_INBOX_DIR            default: uploads/documents-inbox
 *   DOCUMENTS_INBOX_USER_EMAIL     which user owns imported docs
 *                                  (falls back to the first Admin)
 *   DOCUMENTS_INBOX_STABILITY_MS   await-write-finish window, default 10000
 */

import fs from "fs";
import path from "path";
import chokidar, { type FSWatcher } from "chokidar";
import { asc, eq } from "drizzle-orm";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import { roles, userRoles, users } from "../db/schema";
import {
  DOCUMENTS_INBOX_DIR,
  SUPPORTED_EXTENSIONS,
} from "./documents.service";
import {
  DuplicateDocumentError,
  EmptySourceFileError,
  importDocumentFromPath,
} from "./import";
import { triggerWorkers } from "./scan-worker";

let watcher: FSWatcher | null = null;
let cachedOwnerId: number | null = null;

function isSupported(file: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Resolve the user that should own documents imported from the
 * inbox. Priority:
 *   1. `DOCUMENTS_INBOX_USER_EMAIL` env var → user must exist.
 *   2. The first user holding the `Admin` role (by user id).
 * Returns null if neither is available; the caller then skips
 * starting the watcher and logs a warning.
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

/** For tests: reset the cached owner so resolveInboxOwnerId is re-queried. */
export function _resetInboxOwnerCache(): void {
  cachedOwnerId = null;
}

/**
 * Import a single inbox file. Exported so the hourly reconcile cron
 * (`inbox-cron.ts`) can replay add events for files the live watcher
 * missed (downtime, network share without inotify, watcher fired while
 * the upstream copy was still streaming).
 */
export async function handleAddedFile(file: string): Promise<void> {
  if (!isSupported(file)) return;
  if (cachedOwnerId === null) {
    cachedOwnerId = await resolveInboxOwnerId();
    if (cachedOwnerId === null) {
      console.warn(
        `[documents.inbox-watcher] no owning user available — skipping ${path.basename(file)}`,
      );
      return;
    }
  }

  try {
    const imported = await importDocumentFromPath({
      userId: cachedOwnerId,
      sourcePath: file,
      originalFilename: path.basename(file),
      mimeType: "application/pdf",
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
  cachedOwnerId = null;
  console.log("[documents.inbox-watcher] stopped");
}
