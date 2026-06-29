import path from "path";

/**
 * HTML must be revalidated on every navigation. Vite's content-hashed assets
 * can safely remain immutable because a changed file receives a new URL.
 * Other public files (manifest, service worker, icons) are cheap to
 * revalidate and may change without a content hash.
 */
export function cacheControlFor(filePath: string): string {
  if (path.basename(filePath) === "index.html") {
    return "no-cache, must-revalidate";
  }

  const segments = path.normalize(filePath).split(path.sep);
  if (segments.includes("assets")) {
    return "public, max-age=31536000, immutable";
  }

  return "no-cache, must-revalidate";
}
