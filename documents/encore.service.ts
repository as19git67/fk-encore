import { Service } from "encore.dev/service";
import { startLocalCron } from "../lib/local-cron";
import "../lib/scheduled-jobs-hooks";

console.log("[boot] documents/encore.service.ts: begin");

// Start the background scan worker as a side-effect of loading this module.
import "./scan-worker";

// Register the hourly cron that replays inbox files the live watcher
// missed (downtime, network share without inotify, etc).
import "./inbox-cron";

// Register the daily storage consistency check that heals rows whose
// disk_path points at a missing file (see fsck.ts).
import "./fsck";

// Register the weekly hint-mining job that analyses reviewed documents
// and generates taxonomy/hint improvement suggestions.
import "./hint-mining-cron";

// Register the daily taxonomy cockpit snapshot that captures KPI metrics
// for the admin dashboard (sonstiges-%, confidence, teacher queue, etc.).
import "./taxonomy-cockpit";

startLocalCron();

import { startInboxWatcher } from "./inbox-watcher";
import { migrateLegacyLayoutOnce } from "./layout-migrator";

// Fire-and-forget: chokidar init should never block service boot.
// Failures are logged inside the watcher.
startInboxWatcher().catch((err) =>
  console.error("[documents] failed to start inbox watcher:", err),
);

// Fire-and-forget: auto-relocate pre-0036 sha256-shard documents into the
// new speaking layout. No-op when no legacy rows exist (cheap indexed scan).
migrateLegacyLayoutOnce().catch((err) =>
  console.error("[documents] failed to run layout migrator:", err),
);

console.log("[boot] documents/encore.service.ts: registering Service");
export default new Service("documents");
console.log("[boot] documents/encore.service.ts: end");
