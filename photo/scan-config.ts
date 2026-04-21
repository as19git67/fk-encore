/**
 * Runtime feature flags read from env at module load.
 *
 * Extracted from photo.service.ts to avoid a static circular import
 * photo.service <-> scan-queue. Both modules are transitively async-init
 * (via db/database.ts top-level await); a static cycle deadlocks boot.
 */

export const ENABLE_LOCAL_FACES = process.env.ENABLE_LOCAL_FACES === "true";
export const ENABLE_LANDMARKS = process.env.ENABLE_LANDMARKS === "true";
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
