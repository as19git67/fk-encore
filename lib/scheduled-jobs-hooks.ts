/**
 * Wires `lib/local-cron.ts` to the rest of the app:
 *
 *   - load / save → `scheduled_job_state` Postgres table
 *   - onStatusChange → realtime fan-out on the "system" channel
 *
 * Loaded once as a side-effect from every service that calls
 * `startLocalCron()` so hooks are in place before the first hydration
 * runs. Idempotent — `setLocalCronHooks` overwrites whatever was
 * registered before, but the wiring is always identical.
 *
 * Realtime audience is every user with `data.manage` (same gate as the
 * admin endpoint). Admin lookup is cached for 30 s to keep the
 * fan-out cheap when several jobs fire in sequence.
 */

import { eq, inArray } from "drizzle-orm";

import db from "../db/database";
import { scheduledJobState } from "../db/schema";
import {
  setLocalCronHooks,
  type JobInspectEntry,
  type JobPersistedState,
} from "./local-cron";

console.log("[boot] lib/scheduled-jobs-hooks.ts: all imports resolved");

// `~encore/clients` is generated at build time. We import lazily so a
// missing generation step (early test runs, codegen-less builds) does
// not break the scheduler module itself.
let clientsPromise: Promise<typeof import("~encore/clients")> | null = null;
async function loadClients() {
  if (!clientsPromise) {
    clientsPromise = import("~encore/clients");
  }
  return clientsPromise;
}

const ADMIN_CACHE_MS = 30_000;
let cachedAdminIds: string[] | null = null;
let cachedAdminAt = 0;

async function loadAdminIds(): Promise<string[]> {
  const now = Date.now();
  if (cachedAdminIds && now - cachedAdminAt < ADMIN_CACHE_MS) {
    return cachedAdminIds;
  }
  try {
    const { user } = await loadClients();
    const { userIds } = await user.listUserIdsWithPermission({
      permission: "data.manage",
    });
    cachedAdminIds = userIds.map((id: number) => String(id));
    cachedAdminAt = now;
  } catch (err) {
    console.warn(
      `[scheduled-jobs-hooks] admin lookup failed: ${(err as Error).message}`,
    );
  }
  return cachedAdminIds ?? [];
}

setLocalCronHooks({
  async load(names) {
    if (names.length === 0) return [];
    const rows = await db
      .select()
      .from(scheduledJobState)
      .where(inArray(scheduledJobState.name, names));
    return rows.map(
      (r): JobPersistedState => ({
        name: r.name,
        enabled: r.enabled,
        last_run_at: r.last_run_at ? new Date(r.last_run_at) : null,
        last_status: (r.last_status as JobPersistedState["last_status"]) ?? null,
        last_duration_ms: r.last_duration_ms,
        last_error: r.last_error,
        run_count: r.run_count,
        error_count: r.error_count,
      }),
    );
  },

  async save(state) {
    const lastRunIso = state.last_run_at?.toISOString() ?? null;
    await db
      .insert(scheduledJobState)
      .values({
        name: state.name,
        enabled: state.enabled,
        last_run_at: lastRunIso,
        last_status: state.last_status,
        last_duration_ms: state.last_duration_ms,
        last_error: state.last_error,
        run_count: state.run_count,
        error_count: state.error_count,
      })
      .onConflictDoUpdate({
        target: scheduledJobState.name,
        set: {
          enabled: state.enabled,
          last_run_at: lastRunIso,
          last_status: state.last_status,
          last_duration_ms: state.last_duration_ms,
          last_error: state.last_error,
          run_count: state.run_count,
          error_count: state.error_count,
          updated_at: new Date().toISOString(),
        },
      });
  },

  async onStatusChange(entry: JobInspectEntry) {
    const userIds = await loadAdminIds();
    if (userIds.length === 0) return;
    try {
      const { realtime } = await loadClients();
      await realtime.publishEvent({
        userIds,
        channel: "system",
        type: "scheduled-job.changed",
        resourceId: entry.name,
        // The full inspect entry — the UI swaps the existing row
        // out with this snapshot, no refetch needed.
        payload: { ...entry },
      });
    } catch (err) {
      console.warn(
        `[scheduled-jobs-hooks] publish failed for ${entry.name}: ${(err as Error).message}`,
      );
    }
  },
});

console.log("[boot] lib/scheduled-jobs-hooks.ts: hooks registered");
