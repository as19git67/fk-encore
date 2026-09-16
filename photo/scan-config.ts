/**
 * Runtime feature flags read from env at module load.
 *
 * Extracted from photo.service.ts to avoid a static circular import
 * photo.service <-> scan-queue. Both modules are transitively async-init
 * (via db/database.ts top-level await); a static cycle deadlocks boot.
 */

export const ENABLE_LOCAL_FACES = process.env.ENABLE_LOCAL_FACES === "true";
// Landmark detection retired in Epic #383 (Grounding-DINO service removed,
// photo_landmarks table dropped). Per-photo "Sehenswürdigkeiten" run
// through the osm-admin POI matcher (ENABLE_POI_DETECTION) instead.
/**
 * Enable per-photo POI detection (Epic #383): for each geotagged
 * upload, query the local geo service for nearby POIs, score the
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

/**
 * Enable text recognition inside photos (issue #1029): every photo goes
 * through PaddleOCR in the receipt-ocr-service, and whatever text is found —
 * a sign, a whiteboard, a menu — becomes searchable and copyable.
 *
 * Off by default: it only works where that service is reachable, and the
 * detection pass costs CPU on every photo in the library.
 */
export const ENABLE_TEXT_OCR = process.env.ENABLE_TEXT_OCR === "true";
