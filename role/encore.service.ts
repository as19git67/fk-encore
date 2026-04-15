import { Service } from "encore.dev/service";
import { maintenanceMiddleware } from "../backup/maintenance";

export default new Service("role", {
  middlewares: [maintenanceMiddleware],
});

