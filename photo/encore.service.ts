// MUST be imported first so UV_THREADPOOL_SIZE is set before libuv
// initialises its default loop (any subsequent import that pulls a
// native addon can trigger initialisation).
import "./boot-tuning";

import { Service } from "encore.dev/service";
import { maintenanceMiddleware } from "../backup/maintenance";
import { migrateStorageLayout } from "./storage-migration";
import { startLocalCron } from "../lib/local-cron";
import "../lib/scheduled-jobs-hooks";

console.log("[boot] photo/encore.service.ts: begin");

// Start background scan workers when the service boots.
import "./scan-worker";

// Register the hourly cron job that reconciles external photo libraries.
import "./library-cron";

// Register the daily cron job that rebuilds Rueckblicke (recaps).
import "./recaps-cron";

// One-time, resumable duplicate-candidate backfill for existing libraries.
import "./duplicate-backfill-cron";

startLocalCron();

import { startConfiguredWatchers } from "./library-watcher";

// Migrate any legacy flat-layout photos to the YYYY/YYYY-MM/... layout.
// Runs once per install (guarded by a flag file inside UPLOAD_DIR).
migrateStorageLayout().catch((err) => {
  console.error("[photo] storage layout migration failed:", err);
});

// Boot chokidar watchers for every library marked auto_import = true.
startConfiguredWatchers().catch((err) => {
  console.error("[photo] failed to start library watchers:", err);
});

console.log("[boot] photo/encore.service.ts: registering Service");

// Photo service for managing photos and albums.
export default new Service("photo", {
  middlewares: [maintenanceMiddleware],
});

console.log("[boot] photo/encore.service.ts: end");
