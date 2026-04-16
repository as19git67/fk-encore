import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec } from "../db/adapter";
import { photos } from "../db/schema";
import {
  UPLOAD_DIR,
  THUMBNAIL_DIR,
  normalizeImageExt,
  pickStorageTimestamp,
  reserveStoragePath,
} from "./photo.service";

/**
 * Flag file marking a completed migration. Presence prevents the migration
 * from re-running on subsequent starts.
 */
const MIGRATION_FLAG = path.join(UPLOAD_DIR, ".storage-layout-migrated");

/**
 * True when `filename` still uses the legacy flat layout (i.e. has no
 * directory component).
 */
function isLegacyFilename(filename: string): boolean {
  return !filename.includes("/") && !filename.includes("\\");
}

/**
 * Remove the entire thumbnail cache. All cached thumbnails reference legacy
 * base names; after a migration those names change, so the cache is stale and
 * is easier to rebuild on demand than to rewrite.
 */
async function purgeThumbnailCache(): Promise<void> {
  try {
    const entries = await fs.promises.readdir(THUMBNAIL_DIR, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(THUMBNAIL_DIR, entry.name);
        await fs.promises.rm(target, { recursive: true, force: true });
      })
    );
    console.log("[photo-migration] Thumbnail cache purged");
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.error("[photo-migration] Failed to purge thumbnail cache:", err);
    }
  }
}

/**
 * Migrate any legacy flat-layout photos to the
 * `YYYY/YYYY-MM/YYYY-MM-DD_at_HH.MM.SS_NN.<ext>` layout.
 *
 * For each photo row whose `filename` is still a flat name:
 *   1. Derive the timestamp from `taken_at` (EXIF) or `created_at`.
 *   2. Reserve a unique slot under `UPLOAD_DIR`.
 *   3. Rename the file on disk.
 *   4. Update `photos.filename` in the DB with the relative subpath.
 *
 * Safe to run multiple times: photo rows that are already in the new layout
 * are skipped. A marker file is written when the full run completes so the
 * migration short-circuits on subsequent starts.
 */
export async function migrateStorageLayout(): Promise<void> {
  if (fs.existsSync(MIGRATION_FLAG)) {
    return;
  }

  console.log("[photo-migration] Starting legacy → dated-folder migration…");

  const rows = await dbAll<{
    id: number;
    filename: string;
    original_name: string;
    mime_type: string;
    taken_at: string | null;
    created_at: string | null;
  }>(
    db
      .select({
        id: photos.id,
        filename: photos.filename,
        original_name: photos.original_name,
        mime_type: photos.mime_type,
        taken_at: photos.taken_at,
        created_at: photos.created_at,
      })
      .from(photos)
  );

  let migrated = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;

  for (const row of rows) {
    if (!isLegacyFilename(row.filename)) {
      skipped++;
      continue;
    }

    const srcPath = path.join(UPLOAD_DIR, row.filename);
    if (!fs.existsSync(srcPath)) {
      console.warn(
        `[photo-migration] Skipping photo ${row.id}: source file missing: ${srcPath}`
      );
      missing++;
      continue;
    }

    try {
      const ext = normalizeImageExt(row.original_name || row.filename, row.mime_type);
      const ts = pickStorageTimestamp(row.taken_at ?? row.created_at ?? null);
      const { absPath, relPath } = await reserveStoragePath(ts, ext);
      // `reserveStoragePath` created an empty placeholder; replace it.
      await fs.promises.rename(srcPath, absPath);
      await dbExec(db.update(photos).set({ filename: relPath }).where(eq(photos.id, row.id)));
      migrated++;
    } catch (err) {
      console.error(`[photo-migration] Failed to migrate photo ${row.id}:`, err);
      failed++;
    }
  }

  if (migrated > 0) {
    await purgeThumbnailCache();
  }

  if (failed === 0) {
    try {
      await fs.promises.writeFile(
        MIGRATION_FLAG,
        `migrated=${migrated} skipped=${skipped} missing=${missing} at=${new Date().toISOString()}\n`
      );
    } catch (err) {
      console.error("[photo-migration] Failed to write migration flag:", err);
    }
  }

  console.log(
    `[photo-migration] Done: migrated=${migrated}, skipped=${skipped}, missing=${missing}, failed=${failed}`
  );
}
