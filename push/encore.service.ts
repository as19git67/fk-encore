import { Service } from "encore.dev/service";

console.log("[boot] push/encore.service.ts: begin");

// Expose API endpoints.
import "./push";

console.log("[boot] push/encore.service.ts: registering Service");
export default new Service("push");
console.log("[boot] push/encore.service.ts: end");
