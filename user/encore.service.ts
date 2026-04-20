import { Service } from "encore.dev/service";
import { maintenanceMiddleware } from "../backup/maintenance";

console.log("[boot] user/encore.service.ts: begin");

console.log("[boot] user/encore.service.ts: registering Service");
export default new Service("user", {
  middlewares: [maintenanceMiddleware],
});
console.log("[boot] user/encore.service.ts: end");

