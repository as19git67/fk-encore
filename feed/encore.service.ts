import { Service } from "encore.dev/service";

console.log("[boot] feed/encore.service.ts: begin");

// Expose API endpoints.
import "./feed";

console.log("[boot] feed/encore.service.ts: registering Service");
export default new Service("feed");
console.log("[boot] feed/encore.service.ts: end");
