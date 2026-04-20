import { Service } from "encore.dev/service";
import { maintenanceMiddleware } from "../backup/maintenance";

console.log("[boot] role/encore.service.ts: begin");

console.log("[boot] role/encore.service.ts: registering Service");
export default new Service("role", {
  middlewares: [maintenanceMiddleware],
});
console.log("[boot] role/encore.service.ts: end");

