/**
 * Outbox retention for realtime events.
 *
 * The outbox exists so reconnecting clients can resume via
 * `lastEventId`. Rows older than RETENTION_DAYS are past the useful
 * window — if a client has been offline that long it will do a full
 * reload anyway — so we prune them on a schedule to keep the table
 * small and the resume query fast.
 */

import { CronJob } from "encore.dev/cron";
import { api } from "encore.dev/api";
import { lt, sql } from "drizzle-orm";
import db from "../db/database";
import { dbExec } from "../db/adapter";
import { realtimeEvents } from "../db/schema";

const RETENTION_DAYS = 7;

interface PruneResult {
  deleted: number;
}

export const pruneRealtimeOutbox = api(
  { expose: false, method: "POST", path: "/internal/realtime/prune-outbox" },
  async (): Promise<PruneResult> => {
    const { changes } = await dbExec(
      db
        .delete(realtimeEvents)
        .where(
          lt(
            realtimeEvents.created_at,
            sql`NOW() - INTERVAL '${sql.raw(String(RETENTION_DAYS))} days'`,
          ),
        ),
    );
    if (changes > 0) {
      console.log(`[realtime.retention] pruned ${changes} outbox rows`);
    }
    return { deleted: changes };
  },
);

const _ = new CronJob("realtime-outbox-prune", {
  title: "Prune realtime event outbox",
  every: "6h",
  endpoint: pruneRealtimeOutbox,
});
