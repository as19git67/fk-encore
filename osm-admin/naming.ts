/**
 * Naming helpers for per-region Docker resources (Epic #383).
 *
 * Container and volume names are global on the host's Docker
 * daemon — when more than one fk-encore deployment shares the same
 * host (typical: a `:test` instance alongside `:latest`), each must
 * scope its OSM resources or they'd collide on a `name already in
 * use` error and could even drop each other's data.
 *
 * `OSM_ADMIN_NAME_PREFIX` is the per-deployment scope. Empty default
 * keeps existing single-deployment installations binary-compatible.
 * Recommended values:
 *   * Prod:  empty (or `prod-` after a one-time rename)
 *   * Test:  `test-`
 *
 * The prefix is read on each call so tests can flip it via
 * process.env without restarting the module graph.
 */

function readPrefix(override?: string): string {
  return override ?? process.env.OSM_ADMIN_NAME_PREFIX ?? "";
}

export type RegionRole = "nominatim" | "overpass";

/**
 * Long-running per-region container name, e.g.
 *   `nominatim-europe-germany-bayern`            (prefix="")
 *   `test-nominatim-europe-germany-bayern`       (prefix="test-")
 */
export function containerName(
  role: RegionRole,
  slugSuffix: string,
  prefixOverride?: string,
): string {
  return `${readPrefix(prefixOverride)}${role}-${slugSuffix}`;
}

/**
 * Per-region named docker volume that backs the bundled Postgres
 * (nominatim) or `/db` (overpass).
 */
export function volumeName(
  role: RegionRole,
  slugSuffix: string,
  prefixOverride?: string,
): string {
  return `${readPrefix(prefixOverride)}fk-encore-osm-${role}-${slugSuffix}`;
}

/** Exported for tests / diagnostics. */
export function activeNamePrefix(): string {
  return readPrefix();
}
