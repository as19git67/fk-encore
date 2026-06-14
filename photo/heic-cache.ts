/**
 * Tiny LRU-with-byte-budget cache for decoded HEIC → JPEG buffers.
 *
 * Decoding HEIC via `heic-convert` (libheif/WASM) is the single most expensive
 * step on the photo pipeline — a 12 MP iPhone HEIC takes 150–300 ms of pure
 * CPU per decode on commodity hardware. Multiple pipelines call
 * `convertHeicToJpeg` for the same file back-to-back:
 *
 *   - thumbnail prewarm (once per target width when not batched)
 *   - quality scoring
 *   - face detection
 *   - landmark detection
 *   - embedding upload (when the originals are HEIC)
 *   - on-demand /photos/file?convert=true from the UI
 *
 * Caching the decoded JPEG buffer — keyed by the *on-disk* path plus the
 * file's mtime — turns every repeated call into a memcpy. The mtime guard
 * makes stale entries self-heal: if a library replaces the file under us,
 * the mtime differs and we decode again.
 *
 * A second, persistent layer caches the same decoded JPEGs on disk so they
 * survive a restart and cover libraries larger than the in-memory budget —
 * the first view of a HEIC after a deploy/reboot no longer pays the 150–300 ms
 * decode. The disk entry is keyed by a hash of the path plus the file's mtime,
 * so a replaced file gets a fresh key and never serves stale bytes.
 *
 * Configuration (env):
 *   HEIC_DECODE_CACHE_ENTRIES  – max resident entries           (default: 32)
 *   HEIC_DECODE_CACHE_BYTES    – soft byte budget before eviction (default: 128 * 1024 * 1024)
 *   HEIC_DECODE_CACHE_DIR      – on-disk cache directory
 *                                (default: <PHOTO_THUMBNAIL_DIR>/.heic-decode;
 *                                 set to "" to disable the disk layer)
 *
 * The in-memory cache evicts LRU entries as soon as EITHER budget is
 * exceeded. Set HEIC_DECODE_CACHE_ENTRIES=0 to disable the in-memory layer
 * (e.g. for memory-tight deployments) — the disk layer keeps working.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_ENTRIES = (() => {
  const raw = process.env.HEIC_DECODE_CACHE_ENTRIES;
  if (raw === undefined) return 32;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 32;
})();

const MAX_BYTES = (() => {
  const raw = process.env.HEIC_DECODE_CACHE_BYTES;
  if (raw === undefined) return 128 * 1024 * 1024; // 128 MiB
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 128 * 1024 * 1024;
})();

// On-disk cache directory. Defaults to a hidden subfolder of the thumbnail
// dir so it shares the same volume/lifecycle as the other derived caches.
// Computed from env directly (not imported from photo.service) to avoid a
// static import cycle. Empty string disables the disk layer.
const DISK_CACHE_DIR = (() => {
  const explicit = process.env.HEIC_DECODE_CACHE_DIR;
  if (explicit !== undefined) return explicit.trim();
  const base = path.resolve(process.env.PHOTO_THUMBNAIL_DIR || "/mnt/data/thumbnails");
  return path.join(base, ".heic-decode");
})();
const DISK_CACHE_ENABLED = DISK_CACHE_DIR !== "";

interface Entry {
  mtimeMs: number;
  size: number;
  buffer: Buffer;
}

// Map preserves insertion order, so delete+set == "touch" to MRU end.
const store = new Map<string, Entry>();
let totalBytes = 0;
let hits = 0;
let misses = 0;
let stale = 0;
let diskHits = 0;
let diskMisses = 0;

function evictIfNeeded(): void {
  while (
    store.size > 0 &&
    (store.size > MAX_ENTRIES || totalBytes > MAX_BYTES)
  ) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    const entry = store.get(oldest);
    if (entry) totalBytes -= entry.size;
    store.delete(oldest);
  }
}

/**
 * Fetch a cached decoded buffer for (filePath, mtimeMs).
 * Returns undefined on miss OR when the cached entry's mtime no longer
 * matches (file on disk was replaced).
 */
export function getHeicDecodeCached(filePath: string, mtimeMs: number): Buffer | undefined {
  if (MAX_ENTRIES === 0) return undefined;
  const entry = store.get(filePath);
  if (!entry) {
    misses++;
    return undefined;
  }
  if (entry.mtimeMs !== mtimeMs) {
    // The file was replaced on disk — evict the stale entry and force a re-decode.
    totalBytes -= entry.size;
    store.delete(filePath);
    stale++;
    return undefined;
  }
  // Promote to MRU by re-inserting.
  store.delete(filePath);
  store.set(filePath, entry);
  hits++;
  return entry.buffer;
}

/**
 * Store a decoded buffer. Called by the decoder after a successful conversion.
 * Pass the mtimeMs that was observed just before decoding so we can detect
 * subsequent file replacements.
 */
export function setHeicDecodeCached(filePath: string, mtimeMs: number, buffer: Buffer): void {
  if (MAX_ENTRIES === 0) return;
  const existing = store.get(filePath);
  if (existing) {
    totalBytes -= existing.size;
    store.delete(filePath);
  }
  const size = buffer.byteLength;
  // Don't let a single outsized decode blow the whole cache — skip caching
  // when the new entry alone would exceed the byte budget.
  if (size > MAX_BYTES) return;
  store.set(filePath, { mtimeMs, size, buffer });
  totalBytes += size;
  evictIfNeeded();
}

// ── Persistent disk layer ───────────────────────────────────────────────────

function diskPathFor(filePath: string, mtimeMs: number): string {
  // Hash the absolute path so arbitrary filenames map to a flat, safe key,
  // and fold the mtime into the name so a replaced file self-invalidates.
  const hash = crypto.createHash("sha1").update(filePath).digest("hex");
  return path.join(DISK_CACHE_DIR, hash.slice(0, 2), `${hash}_${Math.round(mtimeMs)}.jpg`);
}

/**
 * Look up a decoded buffer on disk for (filePath, mtimeMs). Resolves to
 * undefined on any miss or IO error. Cheap relative to a HEIC decode.
 */
export async function getHeicDecodeDisk(
  filePath: string,
  mtimeMs: number,
): Promise<Buffer | undefined> {
  if (!DISK_CACHE_ENABLED) return undefined;
  try {
    const buf = await fs.promises.readFile(diskPathFor(filePath, mtimeMs));
    diskHits++;
    return buf;
  } catch {
    diskMisses++;
    return undefined;
  }
}

/**
 * Persist a decoded buffer to disk. Fire-and-forget: a failed write (e.g.
 * read-only volume, race) just means the next call re-decodes. Writes to a
 * temp file then renames so a concurrent reader never sees a partial file.
 */
export function setHeicDecodeDisk(filePath: string, mtimeMs: number, buffer: Buffer): void {
  if (!DISK_CACHE_ENABLED) return;
  const dest = diskPathFor(filePath, mtimeMs);
  void (async () => {
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.promises.writeFile(tmp, buffer);
      await fs.promises.rename(tmp, dest);
    } catch {
      // best-effort cache; ignore
    }
  })();
}

export interface HeicCacheStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  hits: number;
  misses: number;
  stale: number;
  diskHits: number;
  diskMisses: number;
  diskEnabled: boolean;
}

export function heicCacheStats(): HeicCacheStats {
  return {
    entries: store.size,
    bytes: totalBytes,
    maxEntries: MAX_ENTRIES,
    maxBytes: MAX_BYTES,
    hits,
    misses,
    stale,
    diskHits,
    diskMisses,
    diskEnabled: DISK_CACHE_ENABLED,
  };
}

/** Clear the in-memory cache + counters. Primarily used by tests. The disk
 *  layer is left intact (it self-invalidates by mtime). */
export function clearHeicDecodeCache(): void {
  store.clear();
  totalBytes = 0;
  hits = 0;
  misses = 0;
  stale = 0;
  diskHits = 0;
  diskMisses = 0;
}
