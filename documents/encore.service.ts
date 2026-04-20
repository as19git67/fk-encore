import { Service } from "encore.dev/service";

console.log("[boot] documents/encore.service.ts: begin");

// Start the background scan worker as a side-effect of loading this module.
import "./scan-worker";

// Register the hourly cron that replays inbox files the live watcher
// missed (downtime, network share without inotify, etc).
import "./inbox-cron";

import { startInboxWatcher } from "./inbox-watcher";

// Fire-and-forget: chokidar init should never block service boot.
// Failures are logged inside the watcher.
startInboxWatcher().catch((err) =>
  console.error("[documents] failed to start inbox watcher:", err),
);

console.log("[boot] documents/encore.service.ts: registering Service");
export default new Service("documents");
console.log("[boot] documents/encore.service.ts: end");
