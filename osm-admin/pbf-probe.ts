/**
 * HEAD-probe helper for Geofabrik .osm.pbf URLs.
 *
 * The Geofabrik index doesn't carry exact file sizes, so before
 * approving / importing a region we issue a single HEAD request and
 * read the `Content-Length` header. The number drives two things:
 *
 *   1. The `pbf_size_mb` column on `osm_region_imports`, so the admin
 *      UI can show the footprint per region.
 *   2. The auto-approve threshold — small regions can move from
 *      `pending_approval` to `importing` without manual approval.
 *
 * Failures (network, missing header, server refuses HEAD) return
 * `null`; the caller treats null as "size unknown" and falls back to
 * the manual approval path.
 */

export interface ProbeOptions {
  /** Test seam — defaults to global `fetch`. */
  fetcher?: typeof fetch;
  /** Timeout in ms (default 10 000). */
  timeoutMs?: number;
}

/**
 * Issue HEAD against `url` and return the `Content-Length` in MB
 * (rounded to the nearest integer). Returns null on any failure.
 */
export async function probePbfSizeMb(
  url: string,
  opts: ProbeOptions = {},
): Promise<number | null> {
  const fetcher = opts.fetcher ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetcher(url, { method: "HEAD", signal: ctrl.signal });
    if (!res.ok) return null;
    const len = res.headers.get("content-length");
    if (!len) return null;
    const bytes = Number(len);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return Math.round(bytes / 1_000_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
