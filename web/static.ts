import fs from "fs";
import path from "path";
import { api } from "encore.dev/api";
import { photo } from "~encore/clients";

// Where the pre-built SPA lives inside the container image. The runtime
// wrapper (docker/Dockerfile.runtime) copies frontend/dist to this absolute
// path, which is deliberately outside of whatever WORKDIR `encore build
// docker` picks so the two cannot collide. Override via FRONTEND_DIST_DIR
// for custom deployments.
const CONTAINER_DIST_DIR = process.env.FRONTEND_DIST_DIR ?? "/srv/frontend/dist";
const LOCAL_DIST_DIR = path.resolve(process.cwd(), "frontend/dist");

function getDistDir(): string {
  return fs.existsSync(CONTAINER_DIST_DIR) ? CONTAINER_DIST_DIR : LOCAL_DIST_DIR;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".woff") return "font/woff";
  if (ext === ".ttf") return "font/ttf";
  return "application/octet-stream";
}

function safeResolve(distDir: string, requestedPath: string): string | null {
  const normalized = requestedPath.replace(/^\/+/, "");
  const resolved = path.resolve(distDir, normalized);
  if (resolved === distDir || resolved.startsWith(`${distDir}${path.sep}`)) {
    return resolved;
  }
  return null;
}

function sendHealthOk(res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void }) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ status: "ok" }));
}

/**
 * Extract share token from a path like "albums/shared/<token>".
 */
function extractShareToken(rawPath: string): string | null {
  const match = rawPath.match(/^albums\/shared\/([A-Za-z0-9_-]+)$/);
  return match ? match[1] : null;
}

/**
 * Escape a string for safe use inside HTML attribute values.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build Open Graph HTML meta tags for a shared album.
 */
function buildOgTags(
  albumName: string,
  description: string,
  photoCount: number,
  imageUrl: string | null,
  pageUrl: string,
): string {
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(albumName)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:site_name" content="Vivanty" />`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
  ];
  if (imageUrl) {
    tags.push(`<meta property="og:image" content="${escapeHtml(imageUrl)}" />`);
    tags.push(`<meta property="og:image:width" content="1200" />`);
    tags.push(`<meta property="og:image:height" content="630" />`);
  }
  return tags.join("\n    ");
}

export const frontend = api.raw(
  { expose: true, method: "GET", path: "/app/*path" },
  async (req, res) => {
    const distDir = getDistDir();
    const url = new URL(req.url ?? "/app/", `http://${req.headers.host ?? "localhost"}`);
    const rawPath = decodeURIComponent(url.pathname.replace(/^\/app\/?/, ""));
    const requested = rawPath.length > 0 ? rawPath : "index.html";
    const assetPath = safeResolve(distDir, requested);

    if (!assetPath) {
      res.statusCode = 400;
      res.end("Bad request");
      return;
    }

    const filePath = fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()
      ? assetPath
      : path.resolve(distDir, "index.html");

    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end("Frontend not built");
      return;
    }

    // For shared album URLs, inject Open Graph meta tags so iMessage/social
    // previews show the album name and cover image instead of just "Vivanty".
    const shareToken = extractShareToken(rawPath);
    if (shareToken && filePath.endsWith("index.html")) {
      try {
        const album = await photo.getPublicAlbum({ token: shareToken });
        const origin = `${req.headers["x-forwarded-proto"] ?? "https"}://${req.headers.host}`;
        const pageUrl = `${origin}/app/albums/shared/${shareToken}`;

        const photoLabel = album.photo_count === 1 ? "1 Foto" : `${album.photo_count} Fotos`;
        const desc = album.description
          ? `${album.description} — ${photoLabel}`
          : `Geteiltes Album — ${photoLabel}`;

        const imageUrl = album.cover_filename
          ? `${origin}/photos/file/${album.cover_filename}?w=1200&convert=true`
          : null;

        const ogTags = buildOgTags(album.name, desc, album.photo_count, imageUrl, pageUrl);

        let html = await fs.promises.readFile(filePath, "utf-8");
        html = html.replace("<title>Vivanty</title>", `<title>${escapeHtml(album.name)} — Vivanty</title>\n    ${ogTags}`);

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.end(html);
        return;
      } catch {
        // Album not found or expired — fall through to serve plain SPA
      }
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeFor(filePath));

    // Add caching headers for static assets
    // We use a shorter TTL for index.html than for hashed assets
    if (requested === "index.html" || !filePath.includes("assets")) {
      res.setHeader("Cache-Control", "public, max-age=3600"); // 1 hour for non-hashed files
    } else {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // 1 year for hashed assets
    }

    fs.createReadStream(filePath).pipe(res);
  }
);

export const rootRedirect = api.raw(
  { expose: true, method: "GET", path: "/" },
  async (_req, res) => {
    res.statusCode = 302;
    res.setHeader("Location", "/app/");
    res.end();
  }
);

export const appRedirect = api.raw(
  { expose: true, method: "GET", path: "/app" },
  async (_req, res) => {
    res.statusCode = 302;
    res.setHeader("Location", "/app/");
    res.end();
  }
);

export const buildInfo = api(
  { expose: true, method: "GET", path: "/api/build-info" },
  async (): Promise<{ build: string }> => {
    return { build: process.env.APP_BUILD_NUMBER ?? "dev" };
  }
);

export const healthz = api.raw(
  { expose: true, method: "GET", path: "/healthz" },
  async (_req, res) => {
    sendHealthOk(res);
  }
);

export const health = api.raw(
  { expose: true, method: "GET", path: "/health" },
  async (_req, res) => {
    sendHealthOk(res);
  }
);

