import { Service } from "encore.dev/service";

console.log("[boot] realtime/encore.service.ts: begin");

// Side-effect import registers the /realtime/subscribe stream endpoint.
import "./subscribe";
// Side-effect import registers the outbox retention cron.
import "./retention-cron";

console.log("[boot] realtime/encore.service.ts: registering Service");
export default new Service("realtime");
console.log("[boot] realtime/encore.service.ts: end");
