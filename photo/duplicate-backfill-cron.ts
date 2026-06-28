import { everyMs, schedule } from "../lib/local-cron";
import { runDuplicateBackfillBatch } from "./duplicate-backfill";

console.log("[boot] photo/duplicate-backfill-cron.ts: registered");

schedule({
  name: "photo-duplicate-backfill",
  description: "Rebuild duplicate candidates for one existing user while the system is idle",
  service: "photo",
  scheduleLabel: "every 10m, one user per run",
  nextFire: everyMs(10 * 60_000),
  run: runDuplicateBackfillBatch,
});
