/**
 * GET /environment — whether this is the dev stack on a copy of production
 * (documentation/plans/dev-system.md), for the thin "Dev" bar above the
 * navigation and the "Dev ·" in front of every page title.
 *
 * Unauthenticated, so the sign-in page carries the mark too. It says no more
 * than the bar shows: prod answers `{ dev: false }`, dev adds the snapshot
 * its copy was cloned from (written by scripts/host/test-refresh.sh into the
 * backup volume) and the mode of each outbound path.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { api } from "encore.dev/api";
import log from "encore.dev/log";
import { isDev, outboundModes, type OutboundKind, type OutboundMode } from "../lib/environment";

// One line at boot, so the log says which paths this dev stack opens.
if (isDev()) log.info("dev stack: outbound modes", outboundModes());

export interface DevCopy {
  /** The snapshot, e.g. `daily-2026-11-14_01-30`. */
  snapshot: string;
  /** The day the snapshot was taken (YYYY-MM-DD), read from its label. */
  date: string | null;
  /** When the refresh ran (ISO). */
  refreshed_at: string | null;
}

export interface EnvironmentResponse {
  dev: boolean;
  copy: DevCopy | null;
  outbound: Partial<Record<OutboundKind, OutboundMode>>;
}

/** Reads `<dataset>@<label>\t<iso>` as the refresh writes it. */
export function parseTestCopy(text: string): DevCopy | null {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  const [origin, refreshed] = line.split("\t");
  const snapshot = (origin ?? "").split("@").pop()?.trim() ?? "";
  if (!snapshot) return null;
  const date = /(\d{4}-\d{2}-\d{2})/.exec(snapshot)?.[1] ?? null;
  return { snapshot, date, refreshed_at: refreshed?.trim() || null };
}

async function readCopy(): Promise<DevCopy | null> {
  const file = path.join(process.env.BACKUP_DIR ?? "/mnt/backup", ".test-copy");
  try {
    return parseTestCopy(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export const environment = api(
  { expose: true, auth: false, method: "GET", path: "/environment" },
  async (): Promise<EnvironmentResponse> => {
    if (!isDev()) return { dev: false, copy: null, outbound: {} };
    return { dev: true, copy: await readCopy(), outbound: outboundModes() };
  },
);
