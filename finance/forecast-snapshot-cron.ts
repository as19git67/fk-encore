/**
 * Retirement forecast — the monthly snapshot (#1342). Every household with
 * a forecast gets one snapshot per scenario about once a month, so the
 * page can show how the plan and the actual wealth drift apart over the
 * years. Runs daily and skips households whose last cron snapshot is
 * younger than CRON_INTERVAL_DAYS.
 */

import log from "encore.dev/log";

import { dailyAtUtc, schedule } from "../lib/local-cron";
import { snapshotDueHouseholds } from "./forecast-snapshots.service";

console.log("[boot] finance/forecast-snapshot-cron.ts: all imports resolved");

export async function runForecastSnapshots(): Promise<number> {
  const written = await snapshotDueHouseholds();
  if (written > 0) log.info("finance-forecast-snapshot: snapshots written", { written });
  return written;
}

// 11:45 Berlin (CEST) / 09:45 UTC — part of the 10–13 Uhr batch window.
schedule({
  name: "finance-forecast-snapshot",
  description: "Monatlicher Stand der Ruhestandsprognose je Szenario",
  service: "finance",
  scheduleLabel: "daily 09:45 UTC",
  nextFire: dailyAtUtc(9, 45),
  run: () => runForecastSnapshots(),
});
