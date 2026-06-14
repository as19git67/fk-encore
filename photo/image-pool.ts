/**
 * Bounded worker-thread pool for sharp-based image operations.
 *
 * Sharp (libvips) calls the libuv thread pool from native code. Under load
 * from scan workers + thumbnail prewarm + on-demand resize the libuv pool
 * (default 4 threads) becomes the bottleneck and starves DB queries and
 * other async IO on the main thread.
 *
 * Running sharp inside dedicated worker threads isolates that CPU work from
 * the main event loop AND from libuv requests issued by the main thread,
 * so HTTP requests stay responsive even when a large prewarm pass is
 * running.
 *
 * Configuration:
 *   IMAGE_POOL_SIZE  – number of worker threads (default: half of CPU count,
 *                      floored to 2, capped at 8). Set to 0 to disable the
 *                      pool and fall back to in-process sharp() calls.
 */

import { Worker } from "node:worker_threads";
import os from "node:os";
import sharp from "sharp";

// Worker source inlined as a string so we don't depend on the Encore build
// emitting a separate worker file. Encore's bundler inlines small modules
// into the combined output, so a side-effect `import "./image-worker"` did
// not actually produce `image-worker.js` next to `image-pool.js` — spawning
// a Worker from that path then failed with ERR_MODULE_NOT_FOUND. Using
// `new Worker(code, { eval: true })` runs the code in a fresh worker
// context and sidesteps the bundler entirely. `require('sharp')` resolves
// via the app's node_modules exactly as it does on the main thread.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const sharp = require('sharp');
parentPort.on('message', async (msg) => {
  try {
    if (msg.op === 'resize') {
      const input = Buffer.from(msg.payload.buffer);
      // failOn: 'none' makes libvips tolerate JPEG warnings such as
      // "Invalid SOS parameters for sequential JPEG" that sharp would
      // otherwise escalate to a hard error, killing the scan job.
      const out = await sharp(input, { failOn: 'none' })
        .rotate()
        .resize(msg.payload.width, null, { withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      parentPort.postMessage({ id: msg.id, ok: true, result: ab }, [ab]);
      return;
    }
    parentPort.postMessage({ id: msg.id, ok: false, error: 'unknown op ' + msg.op });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: (err && err.message) || String(err) });
  }
});
`;

const DEFAULT_POOL_SIZE = Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2)));

const POOL_SIZE = (() => {
  const raw = process.env.IMAGE_POOL_SIZE;
  if (raw === undefined) return DEFAULT_POOL_SIZE;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_POOL_SIZE;
  return n;
})();

/**
 * Workers kept free for high-priority (user-facing) resizes. Background work
 * — thumbnail prewarm, embedding-upload resize — runs at low priority and may
 * occupy at most POOL_SIZE - RESERVE workers, so a large prewarm pass can
 * never starve photos a user is actively viewing. Only meaningful when the
 * pool has more than one worker. Override with IMAGE_POOL_RESERVE.
 */
const LOW_PRIORITY_RESERVE = (() => {
  const def = POOL_SIZE > 1 ? 1 : 0;
  const raw = process.env.IMAGE_POOL_RESERVE;
  if (raw === undefined) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, Math.max(0, POOL_SIZE - 1));
})();
const LOW_PRIORITY_CAP = Math.max(0, POOL_SIZE - LOW_PRIORITY_RESERVE);

export type ImagePoolPriority = "high" | "low";

interface PendingJob {
  id: number;
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
}

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  /** True while running a low-priority (background) job — tracked so the
   *  reserve cap can be enforced when the worker is freed. */
  low: boolean;
  pending: Map<number, PendingJob>;
}

let workers: PooledWorker[] = [];
let started = false;
let nextJobId = 1;
// Separate queues so high-priority waiters are always served before any
// low-priority ones, regardless of arrival order.
const highQueue: Array<(w: PooledWorker) => void> = [];
const lowQueue: Array<(w: PooledWorker) => void> = [];
let lowActive = 0;

/**
 * Hand idle workers to waiters: all high-priority ones first, then low —
 * but low only up to LOW_PRIORITY_CAP concurrent jobs so the reserve stays
 * available for high-priority work.
 */
function dispatch(): void {
  while (highQueue.length > 0) {
    const w = workers.find((x) => !x.busy);
    if (!w) return;
    w.busy = true;
    w.low = false;
    (highQueue.shift()!)(w);
  }
  while (lowQueue.length > 0 && lowActive < LOW_PRIORITY_CAP) {
    const w = workers.find((x) => !x.busy);
    if (!w) return;
    w.busy = true;
    w.low = true;
    lowActive++;
    (lowQueue.shift()!)(w);
  }
}

function releaseWorker(w: PooledWorker): void {
  w.busy = false;
  if (w.low) {
    w.low = false;
    lowActive = Math.max(0, lowActive - 1);
  }
  dispatch();
}

function spawnWorker(): PooledWorker {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  const w: PooledWorker = { worker, busy: false, low: false, pending: new Map() };

  worker.on("message", (msg: { id: number; ok: boolean; result?: ArrayBuffer; error?: string }) => {
    const pending = w.pending.get(msg.id);
    if (!pending) return;
    w.pending.delete(msg.id);
    if (msg.ok && msg.result) {
      pending.resolve(Buffer.from(msg.result));
    } else {
      pending.reject(new Error(msg.error ?? "worker returned no result"));
    }
    // Free the worker and hand it (and any other idle ones) to waiters.
    releaseWorker(w);
  });

  worker.on("error", (err) => {
    console.error("[image-pool] worker error:", err);
    for (const job of w.pending.values()) job.reject(err);
    w.pending.clear();
    if (w.low) {
      w.low = false;
      lowActive = Math.max(0, lowActive - 1);
    }
    w.busy = false;
    // Respawn on crash so the pool stays at capacity.
    const idx = workers.indexOf(w);
    if (idx >= 0) workers.splice(idx, 1);
    try {
      workers.push(spawnWorker());
    } catch (spawnErr) {
      console.error("[image-pool] respawn failed:", spawnErr);
    }
    dispatch();
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[image-pool] worker exited with code ${code}`);
    }
  });

  return w;
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  if (POOL_SIZE === 0) {
    console.log("[image-pool] disabled (IMAGE_POOL_SIZE=0) — using in-process sharp()");
    return;
  }
  for (let i = 0; i < POOL_SIZE; i++) {
    workers.push(spawnWorker());
  }
  console.log(
    `[image-pool] started with ${POOL_SIZE} worker(s), ${LOW_PRIORITY_RESERVE} reserved for high-priority`,
  );
}

function acquire(priority: ImagePoolPriority): Promise<PooledWorker | null> {
  if (POOL_SIZE === 0) return Promise.resolve(null);
  ensureStarted();
  return new Promise((resolve) => {
    (priority === "low" ? lowQueue : highQueue).push((w) => resolve(w));
    dispatch();
  });
}

/**
 * Resize an image buffer to the given width, preserving aspect ratio. Uses
 * the worker pool when available; falls back to an in-process sharp() call
 * when IMAGE_POOL_SIZE=0 or the pool fails to spawn.
 *
 * `priority` defaults to "high" (user-facing serving). Background callers
 * (thumbnail prewarm, embedding-upload resize) pass "low" so they yield the
 * reserved workers to anyone actively viewing photos.
 *
 * Always outputs JPEG (quality 85). No upscaling: images already smaller
 * than `targetWidth` are returned unchanged.
 */
export async function resizeImageInPool(
  imageBuffer: Buffer,
  targetWidth: number,
  opts?: { priority?: ImagePoolPriority },
): Promise<Buffer> {
  const w = await acquire(opts?.priority ?? "high");
  if (!w) {
    // Pool disabled — do the work inline. Same semantics as the original
    // resizeImage so callers can rely on identical output.
    return sharp(imageBuffer, { failOn: 'none' })
      .rotate()
      .resize(targetWidth, null, { withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  }

  const id = nextJobId++;
  return new Promise<Buffer>((resolve, reject) => {
    w.pending.set(id, { id, resolve, reject });
    // Transfer the ArrayBuffer so we don't duplicate large image bytes across
    // the worker boundary.
    const ab = imageBuffer.buffer.slice(
      imageBuffer.byteOffset,
      imageBuffer.byteOffset + imageBuffer.byteLength,
    ) as ArrayBuffer;
    w.worker.postMessage(
      { id, op: "resize", payload: { buffer: ab, width: targetWidth } },
      [ab],
    );
  });
}

/**
 * Shut down all worker threads. Used by tests and the graceful-shutdown
 * path.
 */
export async function stopImagePool(): Promise<void> {
  const toStop = workers;
  workers = [];
  started = false;
  highQueue.length = 0;
  lowQueue.length = 0;
  lowActive = 0;
  await Promise.all(toStop.map((w) => w.worker.terminate().catch(() => {})));
}

export function imagePoolSize(): number {
  return POOL_SIZE;
}
