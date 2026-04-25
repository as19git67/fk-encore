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

import { startFinanceImportWatcher } from "./import-pending";

// Fire-and-forget: the dropbox watcher must not block service boot.
// Failures are logged inside the watcher. Mirrors the documents
// inbox-watcher startup in documents/encore.service.ts. Needed because
// Encore.ts CronJobs only fire under Encore Cloud — in self-hosted
// `encore build docker` deployments the cron registers but never
// triggers, so without this watcher *.pending.json files would sit in
// the dropbox forever.
startFinanceImportWatcher().catch((err) =>
  console.error("[finance] failed to start import watcher:", err),
);

console.log("[boot] finance/encore.service.ts: registering Service");
export default new Service("finance");
console.log("[boot] finance/encore.service.ts: end");
