import { everyMs, schedule } from "../lib/local-cron";
import { cleanupStaleSlots, ensureStartupSlotsCleared } from "./api";

const CLEANUP_INTERVAL_MS = parseInt(
  process.env.AI_QUEUE_CLEANUP_INTERVAL_MS ?? "60000",
  10,
);

ensureStartupSlotsCleared().catch((err) => {
  console.error("[ai-queue] startup slot cleanup failed:", err);
});

schedule({
  name: "ai-queue-stale-cleanup",
  scheduleLabel: `every ${CLEANUP_INTERVAL_MS / 1000}s`,
  nextFire: everyMs(CLEANUP_INTERVAL_MS),
  run: async () => {
    await cleanupStaleSlots();
  },
});
