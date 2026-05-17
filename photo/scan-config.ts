/**
 * Runtime feature flags read from env at module load.
 *
 * Extracted from photo.service.ts to avoid a static circular import
 * photo.service <-> scan-queue. Both modules are transitively async-init
 * (via db/database.ts top-level await); a static cycle deadlocks boot.
 */

export const ENABLE_LOCAL_FACES = process.env.ENABLE_LOCAL_FACES === "true";
/**
 * @deprecated Retired in Epic #383. The Grounding-DINO landmark-service
 * is no longer maintained; per-photo landmark detection runs through
 * the osm-admin POI matcher (ENABLE_POI_DETECTION) instead. The env
 * variable is still read for shape-compatibility with old configs but
 * the value is ignored — no new `landmark` jobs are enqueued.
 */
export const ENABLE_LANDMARKS = false;
/**
 * Enable per-photo POI detection (Epic #383): for each geotagged
 * upload, query the local Overpass shard for nearby POIs, score the
 * candidates against cached DINOv2 reference embeddings, and persist
 * the top match(es) in photo_poi_matches.
 *
 * Off by default — only useful once at least one OSM region has been
 * imported via the osm-admin service.
 */
export const ENABLE_POI_DETECTION = process.env.ENABLE_POI_DETECTION === "true";
export const ENABLE_QUALITY = process.env.ENABLE_QUALITY !== "false"; // enabled by default

/**
 * When enabled the `thumbnail` scan worker pre-generates the common
 * thumbnail widths into THUMBNAIL_DIR so the /photos/file request path
 * never has to call sharp() on cache-miss. Enabled by default; set
 * ENABLE_THUMBNAIL_PREWARM=false to disable (e.g. for test/CI where
 * disk space is tight).
 */
export const ENABLE_THUMBNAIL_PREWARM = process.env.ENABLE_THUMBNAIL_PREWARM !== "false";

/**
 * Widths (in CSS pixels) that the thumbnail prewarm job generates for
 * every photo. The frontend currently requests 320/640/1280; override
 * with a comma-separated list to match a different design system.
 */
export const THUMBNAIL_PREWARM_WIDTHS: number[] = (process.env.THUMBNAIL_PREWARM_WIDTHS || "320,640,1280")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
