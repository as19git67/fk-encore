import { Service } from "encore.dev/service";
import { maintenanceMiddleware } from "../backup/maintenance";
import { migrateStorageLayout } from "./storage-migration";

// Start background scan workers when the service boots.
import "./scan-worker";

// Register the hourly cron job that reconciles external photo libraries.
import "./library-cron";

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

// Photo service for managing photos and albums.
export default new Service("photo", {
  middlewares: [maintenanceMiddleware],
});
