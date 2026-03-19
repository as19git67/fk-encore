import fs from "fs";
import path from "path";
import { api } from "encore.dev/api";

const CONTAINER_DIST_DIR = "/app/frontend/dist";
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

    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeFor(filePath));
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

