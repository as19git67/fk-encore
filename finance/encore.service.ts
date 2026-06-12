/**
 * Service boot for the finance module.
 *
 * Side-effect imports register scheduled jobs with `lib/local-cron.ts`
 * on module load. We then call `startLocalCron()` once to arm the
 * timers. Encore.ts CronJobs themselves don't fire in our self-host
 * docker setup (no Encore Cloud control plane), so we run our own
 * scheduler — see lib/local-cron.ts.
 *
 * Architecture: docs/finance-service-layout.md.
 */

import { Service } from "encore.dev/service";

import { startLocalCron } from "../lib/local-cron";
// Side-effect: registers DB persistence + realtime fan-out hooks for
// the scheduler before any startLocalCron() runs.
import "../lib/scheduled-jobs-hooks";

console.log("[boot] finance/encore.service.ts: begin");

// Side-effect imports — each module calls schedule() at top-level:
//   - statements-cron:    finance-sync-statements (5m), finance-tan-cleanup (1h)
//   - export-cron:        finance-export-snapshot (daily 03:00 UTC)
//   - tag-cleanup-cron:   finance-ai-tag-cleanup (daily 05:00 UTC)
//   - import-pending:     no scheduled job (chokidar watcher handles it),
//                         but the module also exposes the internal scan
//                         endpoint, so we still need it loaded.
import "./statements-cron";
import "./import-pending";
import "./export-cron";
// Side-effect: registers the daily AI analysis suggestion cron.
import "./analysis-suggestions-cron";
// Side-effect: starts the AI tag suggestion worker loop.
import "./tag-worker";
// Side-effect: registers the daily AI-tag cleanup cron.
import "./tag-cleanup-cron";

import { startFinanceImportWatcher } from "./import-pending";

// Arm all timers registered above. Synchronous, fire-and-forget jobs
// run on their own timers from here on.
startLocalCron();

// Fire-and-forget: the dropbox watcher must not block service boot.
// Failures are logged inside the watcher. Mirrors the documents
// inbox-watcher startup in documents/encore.service.ts.
startFinanceImportWatcher().catch((err) =>
  console.error("[finance] failed to start import watcher:", err),
);

console.log("[boot] finance/encore.service.ts: registering Service");
export default new Service("finance");
console.log("[boot] finance/encore.service.ts: end");
