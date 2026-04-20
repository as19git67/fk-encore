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
