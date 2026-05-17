/**
 * Free-disk-space probe used by the region importer to gate large
 * imports. `node:fs.statfs` reports values for the filesystem holding
 * the given path; we default to `/` because the osm-admin container's
 * overlay filesystem typically backs onto the docker storage volume.
 *
 * For a fully accurate reading of the host's docker data directory,
 * the operator can bind-mount it read-only and point this probe at
 * the mount via `OSM_ADMIN_DISK_PROBE_PATH=/path/inside/container`.
 *
 * Any failure (path missing, permission, unsupported filesystem)
 * returns `null` — the importer treats that as "unknown, skip the
 * pre-check" rather than blocking the import.
 */

import { statfs } from "node:fs/promises";

export interface StatfsLike {
  bsize: number | bigint;
  bavail: number | bigint;
}

export type StatfsFn = (path: string) => Promise<StatfsLike>;

/**
 * Returns free space (MB) of the filesystem holding `path`, or `null`
 * on any failure. `statfsImpl` is injected for tests — ESM doesn't let
 * vitest spy on `node:fs/promises` exports.
 */
export async function freeDiskMb(
  path: string = process.env.OSM_ADMIN_DISK_PROBE_PATH ?? "/",
  statfsImpl: StatfsFn = statfs as StatfsFn,
): Promise<number | null> {
  try {
    const s = await statfsImpl(path);
    // statfs returns BigInt-typed values on Node 20+ when free space
    // can exceed 2³¹ bytes. Coerce defensively.
    const bsize = Number(s.bsize ?? 0);
    const bavail = Number(s.bavail ?? 0);
    if (bsize <= 0 || bavail < 0) return null;
    return Math.floor((bavail * bsize) / 1_000_000);
  } catch {
    return null;
  }
}
