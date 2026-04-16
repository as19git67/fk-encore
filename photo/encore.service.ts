import { Service } from "encore.dev/service";
import { maintenanceMiddleware } from "../backup/maintenance";
import { migrateStorageLayout } from "./storage-migration";

// Start background scan workers when the service boots.
import "./scan-worker";

// Migrate any legacy flat-layout photos to the YYYY/YYYY-MM/... layout.
// Runs once per install (guarded by a flag file inside UPLOAD_DIR).
migrateStorageLayout().catch((err) => {
  console.error("[photo] storage layout migration failed:", err);
});

// Photo service for managing photos and albums.
export default new Service("photo", {
  middlewares: [maintenanceMiddleware],
});
