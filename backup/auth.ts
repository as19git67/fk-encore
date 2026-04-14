/**
 * Defence-in-depth authentication for the /internal/backup/* endpoints.
 *
 * Two checks run in sequence before the handler executes:
 *
 *   1. Network origin (backup/ip-allow.ts) — the remote address must fall
 *      inside an allow-listed CIDR (loopback + RFC1918 by default). This
 *      blocks the "port 8080 is exposed to the internet" class of
 *      mistakes even if the token ever leaks.
 *
 *   2. Bearer token (BACKUP_TOKEN env var) — compared in constant time
 *      against the shared secret that scripts/host/install-backup-hook.sh
 *      generates and also writes to /etc/fk-encore/backup-token.
 *
 * Both failures surface as APIError.unauthenticated so the endpoint does
 * not leak which layer rejected the request.
 */

import { APIError } from "encore.dev/api";
import type { IncomingMessage } from "http";
import { effectiveRemoteAddress, isRemoteAllowed } from "./ip-allow";

/** Extracted for tests — call from api.raw handlers with the IncomingMessage. */
export function assertBackupRequest(req: IncomingMessage): void {
  assertRemoteAllowed(req);
  assertBackupToken(req.headers["authorization"]);
}

function assertRemoteAllowed(req: IncomingMessage): void {
  const socketAddr = req.socket?.remoteAddress;
  const addr = effectiveRemoteAddress(socketAddr, req.headers["x-forwarded-for"]);
  if (!isRemoteAllowed(addr)) {
    throw APIError.unauthenticated(
      `remote address ${addr ?? "<unknown>"} is not in BACKUP_ALLOW_CIDRS`,
    );
  }
}

/**
 * Throws APIError.unauthenticated if the Authorization header does not carry
 * the expected bearer token. A constant-time comparison is used to avoid
 * timing oracles.
 */
export function assertBackupToken(authorization: string | string[] | undefined): void {
  const expected = process.env.BACKUP_TOKEN;
  if (!expected) {
    // Failing closed: if no token is provisioned, the endpoints are unusable.
    throw APIError.unauthenticated("BACKUP_TOKEN is not set — backup endpoints are disabled");
  }

  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header) {
    throw APIError.unauthenticated("missing Authorization header");
  }

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw APIError.unauthenticated("invalid Authorization header format, expected: Bearer <token>");
  }

  if (!constantTimeEqual(parts[1], expected)) {
    throw APIError.unauthenticated("invalid backup token");
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
