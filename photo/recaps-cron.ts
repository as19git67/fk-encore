/**
 * Daily rebuild of Rueckblicke (recaps) for every user.
 *
 * "On this day" recaps depend on the current date, so the job has to run at
 * least once every 24 hours — otherwise the feed would be stuck on the
 * previous day. Trip recaps change much less often but we rebuild them in the
 * same pass for simplicity.
 */

import { CronJob } from "encore.dev/cron";
import { rebuildRecapsInternal } from "./recaps";

console.log("[boot] photo/recaps-cron.ts: all imports resolved");

const _ = new CronJob("recaps-rebuild", {
  title: "Rebuild Rueckblicke (recaps) for all users",
  every: "24h",
  endpoint: rebuildRecapsInternal,
});
