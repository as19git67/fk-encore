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
 * Configuration (env):
 *   HEIC_DECODE_CACHE_ENTRIES  – max resident entries           (default: 32)
 *   HEIC_DECODE_CACHE_BYTES    – soft byte budget before eviction (default: 128 * 1024 * 1024)
 *
 * The cache evicts LRU entries as soon as EITHER budget is exceeded. Set
 * HEIC_DECODE_CACHE_ENTRIES=0 to disable entirely (e.g. for memory-tight
 * deployments where the decode cost is acceptable).
 */

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

export interface HeicCacheStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  hits: number;
  misses: number;
  stale: number;
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
  };
}

/** Clear the cache. Primarily used by tests. */
export function clearHeicDecodeCache(): void {
  store.clear();
  totalBytes = 0;
  hits = 0;
  misses = 0;
  stale = 0;
}
