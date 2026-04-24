// Shared HTTP helpers for the sharedalbum service's raw endpoints.
//
// Guests authenticate via an HttpOnly cookie, so every endpoint here is
// declared as `api.raw` (Encore's typed API layer doesn't expose
// Set-Cookie). The helpers mirror the ones in backup/api.ts but add
// cookie parsing / building.

import type { IncomingMessage, ServerResponse } from "http";
import { APIError } from "encore.dev/api";
import log from "encore.dev/log";

// Status-code mapping for APIError codes (subset used here).
const API_ERROR_STATUS: Record<string, number> = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  already_exists: 409,
  failed_precondition: 400,
  resource_exhausted: 429,
  internal: 500,
  unavailable: 503,
};

export async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      throw APIError.invalidArgument(`request body exceeds ${limit} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseJsonBody<T>(raw: string): T {
  if (!raw.trim()) {
    throw APIError.invalidArgument("empty request body, expected JSON");
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err: any) {
    throw APIError.invalidArgument(`invalid JSON body: ${err?.message ?? err}`);
  }
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

export function writeRedirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

export function writeError(res: ServerResponse, err: unknown): void {
  if (err instanceof APIError) {
    const status = API_ERROR_STATUS[err.code] ?? 500;
    writeJson(res, status, {
      code: err.code,
      message: err.message,
      details: (err as any).details ?? null,
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error(err as any, "sharedalbum.unhandled");
  writeJson(res, 500, { code: "internal", message, details: null });
}

// ---------- Cookies ----------

export const GUEST_SESSION_COOKIE = "fk_guest_session";

// 90 days, matches guest_sessions.expires_at default.
export const GUEST_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function buildSessionCookie(token: string, maxAgeMs: number = GUEST_SESSION_TTL_MS): string {
  const secure = process.env.NODE_ENV === "production";
  const parts = [
    `${GUEST_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production";
  const parts = [
    `${GUEST_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
