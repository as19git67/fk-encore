import { Service } from "encore.dev/service";
import { maintenanceMiddleware } from "../backup/maintenance";

// Register the digest cron job at service boot.
import "./digest-cron";

console.log("[boot] sharedalbum/encore.service.ts: registering Service");

// Guest-facing endpoints for public album share-links: guest
// registration (email + name), magic-link verification, session
// cookie management, guest-authored comments, notification fan-out
// and the digest cron that turns them into summary mails.
export default new Service("sharedalbum", {
  middlewares: [maintenanceMiddleware],
});
