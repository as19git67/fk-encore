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

// Register cron jobs:
//   - statements-cron:  bank syncs + TAN-session cleanup
//   - import-pending:   filesystem dropbox for *.pending.json files
//   - export-cron:      daily JSON snapshot of every finance_* table
// Encore only discovers CronJobs along the import graph rooted at this
// service file, so leaving these out means the crons never register
// even though the files compile fine.
import "./statements-cron";
import "./import-pending";
import "./export-cron";

console.log("[boot] finance/encore.service.ts: registering Service");
export default new Service("finance");
console.log("[boot] finance/encore.service.ts: end");
