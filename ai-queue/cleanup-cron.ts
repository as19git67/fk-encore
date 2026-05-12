import { everyMs, schedule } from "../lib/local-cron";
import { cleanupStaleSlots } from "./api";

const CLEANUP_INTERVAL_MS = parseInt(
  process.env.AI_QUEUE_CLEANUP_INTERVAL_MS ?? "60000",
  10,
);

schedule({
  name: "ai-queue-stale-cleanup",
  scheduleLabel: `every ${CLEANUP_INTERVAL_MS / 1000}s`,
  nextFire: everyMs(CLEANUP_INTERVAL_MS),
  run: async () => {
    await cleanupStaleSlots();
  },
});
