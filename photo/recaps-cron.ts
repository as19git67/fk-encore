/**
 * Daily rebuild of Rueckblicke (recaps) for every user.
 *
 * "On this day" recaps depend on the current date, so the job has to run at
 * least once every 24 hours — otherwise the feed would be stuck on the
 * previous day. Trip recaps change much less often but we rebuild them in the
 * same pass for simplicity.
 */

import { rebuildRecapsInternal } from "./recaps";
import { everyMs, schedule } from "../lib/local-cron";

console.log("[boot] photo/recaps-cron.ts: all imports resolved");

schedule({
  name: "recaps-rebuild",
  description: "Rebuild Rueckblicke (recaps) for all users",
  service: "photo",
  scheduleLabel: "every 24h",
  nextFire: everyMs(24 * 60 * 60_000),
  run: () => rebuildRecapsInternal(),
});
