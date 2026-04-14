/**
 * Shared-secret authentication for the /internal/backup/* endpoints.
 *
 * The token is provisioned by scripts/host/install-backup-hook.sh which writes
 * the same value to /etc/fk-encore/backup-token on the host (consumed by the
 * backup cron) and to the Encore secret "BackupToken" (consumed here).
 */

import { APIError } from "encore.dev/api";
import { secret } from "encore.dev/config";

const backupToken = secret("BackupToken");

/**
 * Throws APIError.unauthenticated if the Authorization header does not carry
 * the expected bearer token. A constant-time comparison is used to avoid
 * timing oracles.
 */
export function assertBackupToken(authorization: string | undefined): void {
  const expected = backupToken();
  if (!expected) {
    // Failing closed: if no token is provisioned, the endpoints are unusable.
    throw APIError.unauthenticated("backup token is not configured on this deployment");
  }

  if (!authorization) {
    throw APIError.unauthenticated("missing Authorization header");
  }

  const parts = authorization.split(" ");
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
