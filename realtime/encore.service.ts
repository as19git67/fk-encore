import { Service } from "encore.dev/service";

console.log("[boot] realtime/encore.service.ts: begin");

// Side-effect import registers the PubSub subscription that dispatches
// user-events to connected WebSocket sessions.
import "./subscribe";
// Side-effect import registers the outbox retention cron.
import "./retention-cron";

console.log("[boot] realtime/encore.service.ts: registering Service");
export default new Service("realtime");
console.log("[boot] realtime/encore.service.ts: end");
