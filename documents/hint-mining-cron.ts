/**
 * Weekly cron job: mine reviewed documents for taxonomy/hint improvements.
 *
 * Runs every Sunday at 03:00 UTC. The mining logic is pure aggregation
 * (no LLM, no network) so it is cheap even on large corpora.
 */

import { api } from "encore.dev/api";
import { runHintMining, type MiningResult } from "./hint-mining";
import { schedule } from "../lib/local-cron";

function weeklyAtUtc(
  dayOfWeek: number,
  hour: number,
  minute: number = 0,
): (after: Date) => Date {
  return (after) => {
    const candidate = new Date(
      Date.UTC(
        after.getUTCFullYear(),
        after.getUTCMonth(),
        after.getUTCDate(),
        hour,
        minute,
        0,
        0,
      ),
    );
    const currentDay = candidate.getUTCDay();
    let daysUntil = (dayOfWeek - currentDay + 7) % 7;
    if (daysUntil === 0 && candidate.getTime() <= after.getTime()) {
      daysUntil = 7;
    }
    candidate.setUTCDate(candidate.getUTCDate() + daysUntil);
    return candidate;
  };
}

export const runHintMiningEndpoint = api(
  { expose: false, method: "POST", path: "/internal/documents/hint-mining" },
  async (): Promise<MiningResult> => {
    return await runHintMining();
  },
);

schedule({
  name: "documents-hint-mining",
  description: "Mine reviewed documents for taxonomy/hint improvements",
  service: "documents",
  scheduleLabel: "weekly Sun 03:00 UTC",
  nextFire: weeklyAtUtc(0, 3, 0),
  run: () => runHintMiningEndpoint(),
});
