import { Service } from "encore.dev/service";
import { maintenanceMiddleware } from "../backup/maintenance";

export default new Service("user", {
  middlewares: [maintenanceMiddleware],
});

