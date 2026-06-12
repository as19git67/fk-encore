/**
 * Periodic cleanup: remove AI tags from transactions that also carry
 * user tags. Once a user has manually tagged a transaction the AI
 * suggestions are no longer needed and would only clutter the UI.
 *
 * Runs daily at 05:00 UTC — after the analysis-suggestions cron
 * (04:00) and well outside the FinTS sync window.
 */

import log from "encore.dev/log";
import { sql } from "drizzle-orm";

import db from "../db/database";
import { dailyAtUtc, schedule } from "../lib/local-cron";

console.log("[boot] finance/tag-cleanup-cron.ts: all imports resolved");

export async function removeAiTagsWhereUserTagged(): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM finance_tag_transaction
    WHERE tag_id IN (SELECT id FROM finance_tag WHERE source = 'ai')
      AND transaction_id IN (
        SELECT DISTINCT tt_user.transaction_id
        FROM finance_tag_transaction tt_user
        JOIN finance_tag t_user ON t_user.id = tt_user.tag_id AND t_user.source = 'user'
        INTERSECT
        SELECT DISTINCT tt_ai.transaction_id
        FROM finance_tag_transaction tt_ai
        JOIN finance_tag t_ai ON t_ai.id = tt_ai.tag_id AND t_ai.source = 'ai'
      )
  `);

  const deleted = Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
  if (deleted > 0) {
    log.info("finance-ai-tag-cleanup: removed AI tags from user-tagged transactions", {
      deleted,
    });
  }
  return deleted;
}

schedule({
  name: "finance-ai-tag-cleanup",
  description: "KI-Tags entfernen wenn manuelle Tags vorhanden",
  service: "finance",
  scheduleLabel: "daily 05:00 UTC",
  nextFire: dailyAtUtc(5, 0),
  run: () => removeAiTagsWhereUserTagged(),
});
