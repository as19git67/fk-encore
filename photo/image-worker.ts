/**
 * Worker-thread script for sharp-based image operations.
 *
 * Keeping sharp() off the main Node thread is important because libvips
 * decode/encode is CPU-bound and saturates the libuv thread pool under
 * scan load, which in turn delays request handlers. Running it in a
 * dedicated worker pool caps the impact and lets the main thread keep
 * serving /photos/index, /photos/details and auth traffic.
 *
 * Protocol: parent sends { id, op, payload }; worker responds with
 *   { id, ok: true,  result }   for success
 *   { id, ok: false, error }    for failure
 *
 * op === "resize":
 *   payload = { buffer: ArrayBuffer, width: number }
 *   result  = ArrayBuffer (JPEG)
 */

import { parentPort } from "node:worker_threads";
import sharp from "sharp";

if (!parentPort) {
  throw new Error("image-worker must be run as a worker_threads module");
}

interface ResizePayload {
  buffer: ArrayBuffer;
  width: number;
}

interface WorkerMessage {
  id: number;
  op: "resize";
  payload: ResizePayload;
}

parentPort.on("message", async (msg: WorkerMessage) => {
  try {
    if (msg.op === "resize") {
      const input = Buffer.from(msg.payload.buffer);
      const out = await sharp(input)
        .rotate()
        .resize(msg.payload.width, null, { withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      parentPort!.postMessage({ id: msg.id, ok: true, result: ab }, [ab]);
      return;
    }
    parentPort!.postMessage({ id: msg.id, ok: false, error: `unknown op ${msg.op}` });
  } catch (err: any) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: err?.message ?? String(err) });
  }
});
