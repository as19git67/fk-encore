/**
 * Early-boot tuning — must be imported as the FIRST thing in
 * encore.service.ts so any setting below takes effect before libuv or
 * other native bindings are initialised.
 *
 * UV_THREADPOOL_SIZE controls how many concurrent blocking operations
 * (fs, crypto, native addons like sharp/heic-convert) libuv can run.
 * The default of 4 is far too low once we combine:
 *   - on-demand thumbnail generation  (sharp + read-file)
 *   - thumbnail prewarm worker        (sharp)
 *   - HEIC conversion in quality/embedding jobs
 *   - chokidar library watchers (stat/readdir bursts)
 * Bumping to 16 by default gives breathing room on typical 4–8 core
 * hosts without wasting memory on a pool nobody uses.
 *
 * Override with UV_THREADPOOL_SIZE in the environment. Setting it there
 * is always preferred — Node reads the variable when the libuv default
 * loop is first initialised, and that may happen before any module code
 * runs (e.g. via a native addon pulled in by a static `import`).
 */

// Only set when the user has not picked an explicit value. We must never
// override an intentional operator-provided size.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "16";
}
console.log(`[boot] UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE}`);
