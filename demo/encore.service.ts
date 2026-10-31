import { Service } from "encore.dev/service";
import log from "encore.dev/log";
import { markInterruptedRuns } from "./run";

console.log("[boot] demo/encore.service.ts: begin");

// Side-effect import registers the status, start, cancel and remove endpoints.
import "./demo";

// A run the previous process was working on cannot continue; mark it failed
// so the Systemstatus card offers to remove what it wrote.
markInterruptedRuns().catch((err) => log.error(err as Error, "demo: marking interrupted runs failed"));

console.log("[boot] demo/encore.service.ts: registering Service");
export default new Service("demo");
console.log("[boot] demo/encore.service.ts: end");
