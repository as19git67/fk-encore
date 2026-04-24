/**
 * Service boot for the finance module.
 *
 * Side-effect imports register the cron jobs (sync + TAN cleanup) on
 * module load, matching the pattern used by documents/encore.service.ts.
 *
 * Architecture: docs/finance-service-layout.md.
 */

import { Service } from "encore.dev/service";

console.log("[boot] finance/encore.service.ts: begin");

// Register cron jobs (sync bank statements + cleanup expired TAN sessions).
import "./statements-cron";

console.log("[boot] finance/encore.service.ts: registering Service");
export default new Service("finance");
console.log("[boot] finance/encore.service.ts: end");
