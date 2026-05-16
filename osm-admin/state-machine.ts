/**
 * Region lifecycle state machine for `osm_region_imports.status`.
 *
 *   pending_approval ── approve ──► importing ── ok    ──► ready_running
 *                                              └─ disk ──► blocked_disk
 *                                              └─ err  ──► failed
 *   ready_running    ── idle    ──► ready_stopped
 *   ready_stopped    ── use     ──► ready_running
 *   blocked_disk     ── retry   ──► pending_approval
 *   failed           ── retry   ──► pending_approval | importing
 *
 * Kept as a pure module so transitions can be validated and unit-tested
 * without touching the database or Docker.
 */

// NOTE: keep `RegionStatus` written out as a literal union rather than
// `(typeof REGION_STATUSES)[number]`. Encore.ts' source-code parser
// does not support indexed-access type queries today and refuses to
// build the service if it sees one.
export type RegionStatus =
  | "pending_approval"
  | "importing"
  | "ready_running"
  | "ready_stopped"
  | "blocked_disk"
  | "failed";

export const REGION_STATUSES: readonly RegionStatus[] = [
  "pending_approval",
  "importing",
  "ready_running",
  "ready_stopped",
  "blocked_disk",
  "failed",
];

const TRANSITIONS: Record<RegionStatus, RegionStatus[]> = {
  pending_approval: ["importing", "failed"],
  importing: ["ready_running", "blocked_disk", "failed"],
  ready_running: ["ready_stopped", "failed"],
  ready_stopped: ["ready_running", "failed"],
  blocked_disk: ["pending_approval", "failed"],
  failed: ["pending_approval", "importing"],
};

export function isRegionStatus(s: string): s is RegionStatus {
  return (REGION_STATUSES as readonly string[]).includes(s as string);
}

export function canTransition(from: RegionStatus, to: RegionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RegionStatus, to: RegionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `invalid region status transition: ${from} → ${to} ` +
        `(allowed from ${from}: ${TRANSITIONS[from].join(", ") || "<none>"})`,
    );
  }
}
