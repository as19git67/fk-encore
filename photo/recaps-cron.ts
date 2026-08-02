/**
 * Daily rebuild of Rueckblicke (recaps) for every user.
 *
 * "On this day" recaps depend on the current date, so the job has to run at
 * least once every 24 hours — otherwise the feed would be stuck on the
 * previous day. Trip recaps change much less often but we rebuild them in the
 * same pass for simplicity.
 */

import { rebuildRecapsInternal } from "./recaps";
import { dailyAtUtc, schedule } from "../lib/local-cron";

console.log("[boot] photo/recaps-cron.ts: all imports resolved");

// 12:30 Berlin (CEST) / 10:30 UTC, after library-reconcile — was
// drifting `every 24h` (relative to last container boot); pinned to a
// fixed UTC time so it lands reliably in the 10–13 Uhr batch window.
schedule({
  name: "recaps-rebuild",
  description: "Rebuild Rueckblicke (recaps) for all users",
  service: "photo",
  scheduleLabel: "daily 10:30 UTC",
  nextFire: dailyAtUtc(10, 30),
  run: () => rebuildRecapsInternal(),
});
