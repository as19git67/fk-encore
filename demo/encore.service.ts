import { Service } from "encore.dev/service";
import log from "encore.dev/log";
import { loadDemoAtBoot } from "./boot";
import { markInterruptedRuns } from "./run";

console.log("[boot] demo/encore.service.ts: begin");

// Side-effect import registers the status, start, cancel and remove endpoints.
import "./demo";

// A run the previous process was working on cannot continue; mark it failed
// so the Systemstatus card offers to remove what it wrote. Then `DEMO_DATA`
// may load the demo into an untouched system (demo/boot.ts), in the
// background, so the server answers meanwhile.
markInterruptedRuns()
  .catch((err) => log.error(err as Error, "demo: marking interrupted runs failed"))
  .then(() => (process.env.NODE_ENV === "test" || process.env.VITEST ? "off" : loadDemoAtBoot()))
  .catch((err) => log.error(err as Error, "demo: loading at boot failed"));

console.log("[boot] demo/encore.service.ts: registering Service");
export default new Service("demo");
console.log("[boot] demo/encore.service.ts: end");
