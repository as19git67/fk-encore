import path from "path";
import fs from "fs/promises";

/**
 * Publish a derived image only once its bytes have been written completely.
 *
 * Thumbnail readers treat an existing cache path as ready-to-serve. Writing
 * directly to that path lets a concurrent request read a truncated JPEG. A
 * same-directory rename is atomic, so readers see only complete files.
 */
export async function writeCacheFileAtomically(destination: string, data: Buffer): Promise<void> {
  const directory = path.dirname(destination);
  const temp = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, destination);
  } finally {
    // rename() removes the temporary name on success. The cache is
    // best-effort, so a failed-write cleanup must never hide the real error.
    await fs.unlink(temp).catch(() => undefined);
  }
}
