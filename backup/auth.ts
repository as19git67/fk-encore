/**
 * Shared-secret authentication for the /internal/backup/* endpoints.
 *
 * The token is read from the `BACKUP_TOKEN` environment variable, matching
 * the rest of the project's configuration style (docker-compose.yml + .env).
 * scripts/host/install-backup-hook.sh generates a random token once and
 * prints the value that should be added to .env as BACKUP_TOKEN plus written
 * to /etc/fk-encore/backup-token for the host-side cron driver.
 */

import { APIError } from "encore.dev/api";

/**
 * Throws APIError.unauthenticated if the Authorization header does not carry
 * the expected bearer token. A constant-time comparison is used to avoid
 * timing oracles.
 */
export function assertBackupToken(authorization: string | undefined): void {
  const expected = process.env.BACKUP_TOKEN;
  if (!expected) {
    // Failing closed: if no token is provisioned, the endpoints are unusable.
    throw APIError.unauthenticated("BACKUP_TOKEN is not set — backup endpoints are disabled");
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
