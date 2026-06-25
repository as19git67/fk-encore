/**
 * Daily job that surfaces due document follow-ups (issue #750).
 *
 * `processDueFollowUps` deletes every follow-up whose date has arrived so the
 * documents re-enter their owners' work-item baskets, and fires a per-document
 * notification. Running once a day is enough — follow-up dates are date-only,
 * so there is nothing to gain from a finer cadence.
 */

import { api } from "encore.dev/api";
import { processDueFollowUps, type ProcessDueResult } from "./follow-ups";
import { dailyAtUtc, schedule } from "../lib/local-cron";

export const runDueFollowUps = api(
  { expose: false, method: "POST", path: "/internal/documents/follow-ups/process-due" },
  async (): Promise<ProcessDueResult> => {
    return await processDueFollowUps();
  },
);

schedule({
  name: "documents-follow-ups-process-due",
  description: "Surface due document follow-ups and notify their owners",
  service: "documents",
  scheduleLabel: "daily 06:00 UTC",
  nextFire: dailyAtUtc(6, 0),
  run: () => runDueFollowUps(),
});
