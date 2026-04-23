import { Service } from "encore.dev/service";
import { maintenanceMiddleware } from "../backup/maintenance";

console.log("[boot] sharedalbum/encore.service.ts: registering Service");

// Guest-facing endpoints for public album share-links: guest
// registration (email + name), magic-link verification, session
// cookie management, and unsubscribe. Guest-authored comments and
// digest mails are handled in follow-up modules.
export default new Service("sharedalbum", {
  middlewares: [maintenanceMiddleware],
});
