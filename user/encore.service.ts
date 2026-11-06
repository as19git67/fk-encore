import { Service } from "encore.dev/service";
import { maintenanceMiddleware } from "../backup/maintenance";
// Side-effect: attaches the shared secret to every outbound call to the
// internal Python services. See lib/internal-service-auth.ts.
import "../lib/internal-service-auth";

console.log("[boot] user/encore.service.ts: begin");

// Side-effect: registers /admin/scheduled-jobs.
import "./scheduled-jobs";
// Side-effect: registers /admin/llm-configs and /admin/llm-models.
import "./llm-models";
// Side-effect: registers /auth/handover (session handover to the web app).
import "./handover";

console.log("[boot] user/encore.service.ts: registering Service");
export default new Service("user", {
  middlewares: [maintenanceMiddleware],
});
console.log("[boot] user/encore.service.ts: end");

