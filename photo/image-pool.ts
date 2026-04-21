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
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const DEFAULT_POOL_SIZE = Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2)));

const POOL_SIZE = (() => {
  const raw = process.env.IMAGE_POOL_SIZE;
  if (raw === undefined) return DEFAULT_POOL_SIZE;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_POOL_SIZE;
  return n;
})();

interface PendingJob {
  id: number;
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
}

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  pending: Map<number, PendingJob>;
}

let workers: PooledWorker[] = [];
let started = false;
let nextJobId = 1;
const waitingQueue: Array<(w: PooledWorker) => void> = [];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the worker module path. In dev (tsx/ts-node) the source is loaded
 * directly; in production (encore build) the transpiled .js sits next to this
 * file. Prefer .js when present to avoid requiring a TS loader inside workers.
 */
function workerScriptPath(): string {
  const jsPath = path.join(__dirname, "image-worker.js");
  const tsPath = path.join(__dirname, "image-worker.ts");
  try {
    if (fs.existsSync(jsPath)) return jsPath;
  } catch {
    // fall through to .ts
  }
  return tsPath;
}

function spawnWorker(): PooledWorker {
  const scriptPath = workerScriptPath();
  // Use execArgv + the tsx loader so .ts files can be loaded inside the
  // worker during dev (Encore dev mode runs TS sources directly).
  const isTs = scriptPath.endsWith(".ts");
  const worker = new Worker(scriptPath, {
    execArgv: isTs ? ["--import", "tsx"] : undefined,
  });
  const w: PooledWorker = { worker, busy: false, pending: new Map() };

  worker.on("message", (msg: { id: number; ok: boolean; result?: ArrayBuffer; error?: string }) => {
    const pending = w.pending.get(msg.id);
    if (!pending) return;
    w.pending.delete(msg.id);
    w.busy = false;
    if (msg.ok && msg.result) {
      pending.resolve(Buffer.from(msg.result));
    } else {
      pending.reject(new Error(msg.error ?? "worker returned no result"));
    }
    // Hand the freed worker to the next waiter, if any.
    const next = waitingQueue.shift();
    if (next) next(w);
  });

  worker.on("error", (err) => {
    console.error("[image-pool] worker error:", err);
    for (const job of w.pending.values()) job.reject(err);
    w.pending.clear();
    w.busy = false;
    // Respawn on crash so the pool stays at capacity.
    const idx = workers.indexOf(w);
    if (idx >= 0) workers.splice(idx, 1);
    try {
      workers.push(spawnWorker());
    } catch (spawnErr) {
      console.error("[image-pool] respawn failed:", spawnErr);
    }
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
  console.log(`[image-pool] started with ${POOL_SIZE} worker(s)`);
}

function acquire(): Promise<PooledWorker | null> {
  if (POOL_SIZE === 0) return Promise.resolve(null);
  ensureStarted();
  const idle = workers.find((w) => !w.busy);
  if (idle) {
    idle.busy = true;
    return Promise.resolve(idle);
  }
  return new Promise((resolve) => {
    waitingQueue.push((w) => {
      w.busy = true;
      resolve(w);
    });
  });
}

/**
 * Resize an image buffer to the given width, preserving aspect ratio. Uses
 * the worker pool when available; falls back to an in-process sharp() call
 * when IMAGE_POOL_SIZE=0 or the pool fails to spawn.
 *
 * Always outputs JPEG (quality 85). No upscaling: images already smaller
 * than `targetWidth` are returned unchanged.
 */
export async function resizeImageInPool(imageBuffer: Buffer, targetWidth: number): Promise<Buffer> {
  const w = await acquire();
  if (!w) {
    // Pool disabled — do the work inline. Same semantics as the original
    // resizeImage so callers can rely on identical output.
    return sharp(imageBuffer)
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
  await Promise.all(toStop.map((w) => w.worker.terminate().catch(() => {})));
}

export function imagePoolSize(): number {
  return POOL_SIZE;
}
