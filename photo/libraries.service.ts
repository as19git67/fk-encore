/**
 * External photo libraries.
 *
 * A library is a directory under PHOTO_LIBRARIES_ROOT. Files inside it can be
 * imported in two modes:
 *   - link: file stays where it is; the photo row stores `external_path` and
 *           is deleted again when the file disappears externally.
 *   - move: file is moved into the standard UPLOAD_DIR layout, after which it
 *           is indistinguishable from a normal upload.
 *
 * Auto-import additionally runs a chokidar watcher that imports new files as
 * they appear and removes link-mode rows when files are deleted.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { eq, and, sql } from "drizzle-orm";
import db from "../db/database";
import { dbFirst, dbAll, dbExec, dbInsertReturning } from "../db/adapter";
import { photoLibraries, photos, albums, albumPhotos } from "../db/schema";
import {
  UPLOAD_DIR,
  SUPPORTED_EXTENSIONS,
  guessMimeFromExt,
  normalizeImageExt,
  pickStorageTimestamp,
  reserveStoragePath,
  getExifMetadata,
  iptcLocationUpdate,
  combineDescription,
} from "./photo.service";
import { enqueuePhotoScan } from "./scan-queue";
import { triggerWorkers } from "./scan-worker";

export const PHOTO_LIBRARIES_ROOT = path.resolve(
  process.env.PHOTO_LIBRARIES_ROOT || "/mnt/libraries"
);

export type LibraryImportMode = "link" | "move";

export interface PhotoLibrary {
  id: number;
  user_id: number;
  name: string;
  path: string;
  import_mode: LibraryImportMode;
  auto_import: boolean;
  auto_albums: boolean;
  created_at: string | null;
  last_scan_at: string | null;
}

export interface CreateLibraryRequest {
  name: string;
  path: string;
  import_mode?: LibraryImportMode;
  auto_import?: boolean;
  auto_albums?: boolean;
}

export interface UpdateLibraryRequest {
  id: number;
  name?: string;
  import_mode?: LibraryImportMode;
  auto_import?: boolean;
  auto_albums?: boolean;
}

export interface ScanReport {
  scanned: number;
  imported: number;
  skipped_duplicate: number;
  skipped_unsupported: number;
  skipped_empty: number;
  errors: number;
}

// ---------- Path validation ----------

/**
 * Resolve a user-supplied library path against PHOTO_LIBRARIES_ROOT and reject
 * anything that escapes the root. Returns the canonical absolute path.
 */
export function resolveLibraryPath(input: string): string {
  if (!input || typeof input !== "string") {
    throw new Error("path is required");
  }
  // Accept either an absolute path that already lives under the root, or a
  // relative path which we anchor at the root. This lets callers supply just
  // "family-archive" and have it become "<root>/family-archive".
  const abs = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(PHOTO_LIBRARIES_ROOT, input);

  const root = PHOTO_LIBRARIES_ROOT.endsWith(path.sep)
    ? PHOTO_LIBRARIES_ROOT
    : PHOTO_LIBRARIES_ROOT + path.sep;
  if (abs !== PHOTO_LIBRARIES_ROOT && !abs.startsWith(root)) {
    throw new Error(`path must be inside PHOTO_LIBRARIES_ROOT (${PHOTO_LIBRARIES_ROOT})`);
  }
  return abs;
}

function ensureReadableDirectory(absPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err: any) {
    throw new Error(`path does not exist: ${absPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`path is not a directory: ${absPath}`);
  }
  try {
    fs.accessSync(absPath, fs.constants.R_OK);
  } catch {
    throw new Error(`path is not readable: ${absPath}`);
  }
}

export interface AvailableDirectory {
  name: string;
  rel_path: string;
  abs_path: string;
  already_registered: boolean;
  mounted: boolean;
}

/**
 * Read /proc/self/mountinfo and return the set of current mount-point paths.
 * Returns an empty set on non-Linux platforms (e.g. local development on
 * macOS) — callers should treat that as "unknown, not detected".
 */
function readMountPoints(): Set<string> {
  try {
    const content = fs.readFileSync("/proc/self/mountinfo", "utf8");
    const points = new Set<string>();
    for (const line of content.split("\n")) {
      // Format: mount-id parent-id major:minor root mount-point options...
      const fields = line.split(" ");
      if (fields.length >= 5 && fields[4]) points.add(fields[4]);
    }
    return points;
  } catch {
    return new Set();
  }
}

export interface LibraryRootInfo {
  root: string;
  root_mounted: boolean;
  /** Currently-browsed location relative to `root`. Empty string = at root. */
  sub: string;
  /** Absolute path of the currently-browsed location. */
  abs_path: string;
  /** True when the current location itself is already registered as a library. */
  current_registered: boolean;
  /** True when the current location is a real mount point (per /proc/mountinfo). */
  current_mounted: boolean;
  directories: AvailableDirectory[];
}

/**
 * List direct sub-directories of PHOTO_LIBRARIES_ROOT for the admin UI picker.
 * Hidden entries (names starting with ".") are skipped. Already-registered
 * directories are returned too, but flagged so the UI can disable them. Each
 * entry also carries a `mounted` flag derived from /proc/self/mountinfo so the
 * admin can tell at a glance which sub-directories are real volume mounts.
 *
 * Pass `sub` (a path relative to PHOTO_LIBRARIES_ROOT) to list sub-directories
 * of a deeper location. Sub paths are validated with `resolveLibraryPath` and
 * must stay inside the root.
 */
export async function listLibraryRootInfo(sub: string = ""): Promise<LibraryRootInfo> {
  const mountPoints = readMountPoints();
  const rootPrefix = PHOTO_LIBRARIES_ROOT.endsWith(path.sep)
    ? PHOTO_LIBRARIES_ROOT
    : PHOTO_LIBRARIES_ROOT + path.sep;
  // Either the root itself is a mount point, or at least one volume is
  // mounted somewhere below it — the recommended per-library layout.
  const rootMounted =
    mountPoints.has(PHOTO_LIBRARIES_ROOT) ||
    [...mountPoints].some((mp) => mp.startsWith(rootPrefix));

  const normalizedSub = sub ? sub.replace(/^\/+|\/+$/g, "") : "";
  const currentAbs = normalizedSub
    ? resolveLibraryPath(normalizedSub)
    : PHOTO_LIBRARIES_ROOT;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(currentAbs, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return {
        root: PHOTO_LIBRARIES_ROOT,
        root_mounted: rootMounted,
        sub: normalizedSub,
        abs_path: currentAbs,
        current_registered: false,
        current_mounted: mountPoints.has(currentAbs),
        directories: [],
      };
    }
    throw new Error(`directory unreadable: ${err?.message ?? err}`);
  }

  const taken = new Set(
    (await dbAll<{ path: string }>(
      db.select({ path: photoLibraries.path }).from(photoLibraries)
    )).map((r) => r.path)
  );

  const dirs: AvailableDirectory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const abs = path.join(currentAbs, entry.name);
    const rel = normalizedSub ? `${normalizedSub}/${entry.name}` : entry.name;
    dirs.push({
      name: entry.name,
      rel_path: rel,
      abs_path: abs,
      already_registered: taken.has(abs),
      mounted: mountPoints.has(abs),
    });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return {
    root: PHOTO_LIBRARIES_ROOT,
    root_mounted: rootMounted,
    sub: normalizedSub,
    abs_path: currentAbs,
    current_registered: taken.has(currentAbs),
    current_mounted: mountPoints.has(currentAbs),
    directories: dirs,
  };
}

// ---------- CRUD ----------

function rowToLibrary(row: typeof photoLibraries.$inferSelect): PhotoLibrary {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    path: row.path,
    import_mode: row.import_mode as LibraryImportMode,
    auto_import: row.auto_import,
    auto_albums: row.auto_albums,
    created_at: row.created_at ?? null,
    last_scan_at: row.last_scan_at ?? null,
  };
}

export async function createLibrary(
  userId: number,
  req: CreateLibraryRequest
): Promise<PhotoLibrary> {
  if (!req.name?.trim()) throw new Error("name is required");
  const abs = resolveLibraryPath(req.path);
  ensureReadableDirectory(abs);

  const existing = await dbFirst<{ id: number }>(
    db.select({ id: photoLibraries.id }).from(photoLibraries).where(eq(photoLibraries.path, abs))
  );
  if (existing) throw new Error("a library with this path already exists");

  const row = await dbInsertReturning<typeof photoLibraries.$inferSelect>(
    db
      .insert(photoLibraries)
      .values({
        user_id: userId,
        name: req.name.trim(),
        path: abs,
        import_mode: req.import_mode ?? "link",
        auto_import: req.auto_import ?? false,
        auto_albums: req.auto_albums ?? false,
      })
      .returning()
  );
  return rowToLibrary(row!);
}

export async function listLibraries(): Promise<PhotoLibrary[]> {
  const rows = await dbAll<typeof photoLibraries.$inferSelect>(
    db.select().from(photoLibraries).orderBy(photoLibraries.id)
  );
  return rows.map(rowToLibrary);
}

export async function getLibrary(id: number): Promise<PhotoLibrary | null> {
  const row = await dbFirst<typeof photoLibraries.$inferSelect>(
    db.select().from(photoLibraries).where(eq(photoLibraries.id, id))
  );
  return row ? rowToLibrary(row) : null;
}

export async function updateLibrary(req: UpdateLibraryRequest): Promise<PhotoLibrary> {
  const existing = await getLibrary(req.id);
  if (!existing) throw new Error(`library ${req.id} not found`);

  const updates: Partial<typeof photoLibraries.$inferInsert> = {};
  if (req.name !== undefined) updates.name = req.name.trim();
  if (req.import_mode !== undefined) updates.import_mode = req.import_mode;
  if (req.auto_import !== undefined) updates.auto_import = req.auto_import;
  if (req.auto_albums !== undefined) updates.auto_albums = req.auto_albums;

  if (Object.keys(updates).length > 0) {
    await dbExec(db.update(photoLibraries).set(updates).where(eq(photoLibraries.id, req.id)));
  }
  return (await getLibrary(req.id))!;
}

export async function deleteLibrary(id: number): Promise<void> {
  // ON DELETE SET NULL on photos.library_id keeps any imported rows around.
  // For `link`-mode libraries, removing the registration does not remove the
  // photo rows — those still point at external_path. The caller can purge them
  // via the regular hard-delete API if desired.
  await dbExec(db.delete(photoLibraries).where(eq(photoLibraries.id, id)));
}

// ---------- Import ----------

async function sha256OfFile(filePath: string): Promise<{ digest: string; size: number }> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let size = 0;
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on("end", () => resolve({ digest: hash.digest("hex"), size }));
    stream.on("error", reject);
  });
}

export type ImportOutcome =
  | { kind: "imported"; photoId: number }
  | { kind: "skipped_duplicate" }
  | { kind: "skipped_unsupported" }
  | { kind: "skipped_empty" };

/**
 * Derive the album name from the file's location relative to the library root.
 * Returns the full relative sub-path (using forward slashes), so a file at
 * `2020/2020-01/img.jpg` ends up in album "2020/2020-01". Files directly in the
 * library root return null — no auto-album is created for those.
 */
function deriveAutoAlbumName(libraryPath: string, absFilePath: string): string | null {
  const rel = path.relative(libraryPath, path.dirname(absFilePath));
  if (!rel || rel === "." || rel.startsWith("..")) return null;
  // Normalise to forward slashes so the album name is platform-independent.
  const normalised = rel.split(path.sep).filter(Boolean).join("/");
  return normalised || null;
}

/**
 * Extract an event label from an album name by stripping date-like fragments
 * (YYYY, YYYY-MM, YYYY-MM-DD) from the last path segment. Returns null when
 * nothing meaningful is left.
 *
 * Examples:
 *   "2020/2020-01"           → null
 *   "2020/2020-06 Hochzeit"  → "Hochzeit"
 *   "2020-06-15-Wedding"     → "Wedding"
 *   "Urlaub Italien"         → "Urlaub Italien"
 */
function deriveEventName(albumName: string): string | null {
  const lastSeg = albumName.split("/").pop() ?? albumName;
  const cleaned = lastSeg
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\b\d{4}-\d{2}\b/g, "")
    .replace(/\b\d{4}\b/g, "")
    .replace(/^[\s\-_]+|[\s\-_]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * Find or create an album with the given name for a specific user, then add
 * the photo to it. Idempotent: calling twice for the same (album, photo) is a
 * no-op thanks to the album_photos primary key. The event label is only
 * written on first creation so manual edits made later are preserved.
 */
async function attachToAutoAlbum(
  ownerId: number,
  albumName: string,
  photoId: number
): Promise<void> {
  let album = await dbFirst<{ id: number }>(
    db
      .select({ id: albums.id })
      .from(albums)
      .where(and(eq(albums.user_id, ownerId), eq(albums.name, albumName)))
  );
  if (!album) {
    const eventName = deriveEventName(albumName);
    album = await dbInsertReturning<{ id: number }>(
      db
        .insert(albums)
        .values({
          user_id: ownerId,
          name: albumName,
          event_name: eventName,
          // Also seed the human-readable description so the event label shows
          // up in existing album UIs without any additional wiring.
          description: eventName,
        })
        .returning({ id: albums.id })
    );
  }
  // ON CONFLICT DO NOTHING keeps the call idempotent across re-scans.
  await dbExec(
    db
      .insert(albumPhotos)
      .values({ album_id: album!.id, photo_id: photoId, added_by_user_id: ownerId })
      .onConflictDoNothing()
  );
}

/**
 * Import a single file from a library. Idempotent: a second call for the same
 * file returns `skipped_duplicate`.
 */
export async function importFile(
  library: PhotoLibrary,
  absFilePath: string
): Promise<ImportOutcome> {
  const ext = path.extname(absFilePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) return { kind: "skipped_unsupported" };
  const mimeType = guessMimeFromExt(ext) ?? "image/jpeg";

  // Library files belong to the configured library owner regardless of who
  // triggered the scan. This keeps ownership stable across re-scans.
  const ownerId = library.user_id;

  const { digest, size } = await sha256OfFile(absFilePath);

  // Skip 0-byte files. They show up when the watcher fires before a network
  // copy is finished. The hourly reconcile cron will pick the file up later
  // once it actually has content.
  if (size === 0) return { kind: "skipped_empty" };

  // Same hash for the same owner → already imported.
  const dup = await dbFirst<{ id: number }>(
    db
      .select({ id: photos.id })
      .from(photos)
      .where(and(eq(photos.user_id, ownerId), eq(photos.hash, digest)))
  );
  if (dup) return { kind: "skipped_duplicate" };

  const exifMeta = await getExifMetadata(absFilePath);
  const storageTs = pickStorageTimestamp(exifMeta.takenAt);
  const originalName = path.basename(absFilePath);
  const descriptionValue = combineDescription(exifMeta);
  const iptcLoc = iptcLocationUpdate(exifMeta);

  let filename: string;
  let externalPath: string | null;

  if (library.import_mode === "move") {
    const normalizedExt = normalizeImageExt(originalName, mimeType);
    const { absPath, relPath } = await reserveStoragePath(storageTs, normalizedExt);
    // rename across filesystems can fail with EXDEV — fall back to copy+unlink.
    try {
      await fs.promises.rename(absFilePath, absPath);
    } catch (err: any) {
      if (err?.code === "EXDEV") {
        await fs.promises.copyFile(absFilePath, absPath);
        await fs.promises.unlink(absFilePath);
      } else {
        // Clean up the empty placeholder reserveStoragePath created.
        await fs.promises.unlink(absPath).catch(() => {});
        throw err;
      }
    }
    filename = relPath;
    externalPath = null;
  } else {
    // link mode — the external path doubles as the canonical location. We
    // still store a relative-looking `filename` for thumbnail/cache sharding;
    // it is derived from the basename so multiple link-imported files keep
    // distinct thumbnail caches even though no file ever lives at that path
    // under UPLOAD_DIR.
    filename = `__library/${library.id}/${path.basename(absFilePath)}`;
    externalPath = absFilePath;
  }

  const row = await dbInsertReturning<typeof photos.$inferSelect>(
    db
      .insert(photos)
      .values({
        user_id: ownerId,
        filename,
        original_name: originalName,
        mime_type: mimeType,
        size,
        hash: digest,
        taken_at: exifMeta.takenAt,
        latitude: exifMeta.latitude,
        longitude: exifMeta.longitude,
        description: descriptionValue,
        keywords: exifMeta.keywords,
        library_id: library.id,
        external_path: externalPath,
        ...(iptcLoc ?? {}),
      })
      .returning()
  );

  if (library.auto_albums) {
    const albumName = deriveAutoAlbumName(library.path, absFilePath);
    if (albumName) {
      try {
        await attachToAutoAlbum(ownerId, albumName, row!.id);
      } catch (err) {
        console.error("[libraries] auto-album attach failed:", err);
      }
    }
  }

  enqueuePhotoScan(row!.id, ownerId)
    .then(() => triggerWorkers())
    .catch((err) => console.error("[libraries] enqueue scan:", err));

  return { kind: "imported", photoId: row!.id };
}

/**
 * Walk a directory recursively and return absolute paths of all supported
 * image files. Skips dotfiles and the standard noise dirs (node_modules etc.)
 * so it can be safely pointed at an entire user home.
 */
async function* walkSupportedFiles(root: string): AsyncGenerator<string> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* walkSupportedFiles(full);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.has(ext)) yield full;
    }
  }
}

export async function scanLibrary(libraryId: number): Promise<ScanReport> {
  const library = await getLibrary(libraryId);
  if (!library) throw new Error(`library ${libraryId} not found`);
  ensureReadableDirectory(library.path);

  const report: ScanReport = {
    scanned: 0,
    imported: 0,
    skipped_duplicate: 0,
    skipped_unsupported: 0,
    skipped_empty: 0,
    errors: 0,
  };

  for await (const file of walkSupportedFiles(library.path)) {
    report.scanned++;
    try {
      const outcome = await importFile(library, file);
      if (outcome.kind === "imported") report.imported++;
      else if (outcome.kind === "skipped_duplicate") report.skipped_duplicate++;
      else if (outcome.kind === "skipped_empty") report.skipped_empty++;
      else report.skipped_unsupported++;
    } catch (err: any) {
      report.errors++;
      console.error(`[libraries] import failed for ${file}:`, err?.message ?? err);
    }
  }

  await dbExec(
    db
      .update(photoLibraries)
      .set({ last_scan_at: new Date().toISOString() })
      .where(eq(photoLibraries.id, libraryId))
  );
  return report;
}

/**
 * Drop the photo row for an externally-removed link-mode file. Identifies the
 * row via `external_path`, which has a unique partial index. No-op for files
 * we never imported.
 */
export async function handleExternalUnlink(absFilePath: string): Promise<boolean> {
  const row = await dbFirst<{ id: number }>(
    db.select({ id: photos.id }).from(photos).where(eq(photos.external_path, absFilePath))
  );
  if (!row) return false;
  await dbExec(db.delete(photos).where(eq(photos.id, row.id)));
  return true;
}

/**
 * Remove DB rows whose external_path no longer exists on disk. Belt-and-
 * suspenders companion to the watcher for events lost during downtime.
 */
export async function reconcileLibrary(libraryId: number): Promise<{ removed: number }> {
  const library = await getLibrary(libraryId);
  if (!library) throw new Error(`library ${libraryId} not found`);
  if (library.import_mode !== "link") return { removed: 0 };

  const rows = await dbAll<{ id: number; external_path: string | null }>(
    db
      .select({ id: photos.id, external_path: photos.external_path })
      .from(photos)
      .where(eq(photos.library_id, libraryId))
  );

  let removed = 0;
  for (const row of rows) {
    if (!row.external_path) continue;
    if (!fs.existsSync(row.external_path)) {
      await dbExec(db.delete(photos).where(eq(photos.id, row.id)));
      removed++;
    }
  }
  return { removed };
}
