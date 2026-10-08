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
// Side-effect: attaches the shared secret to every outbound call to the
// internal Python services. See lib/internal-service-auth.ts.
import "../lib/internal-service-auth";

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
import "./document-match-cleanup-cron";
// Side-effect: registers the monthly snapshot of the retirement forecast (#1342).
import "./forecast-snapshot-cron";
// Side-effect: registers the refresh of the held securities' quotes.
import "./quotes-cron";
import { setNewsProvider, setQuoteProvider } from "./quote-provider";
import { yahooQuoteProvider } from "./quote-provider-yahoo";
import { onvistaQuoteProvider } from "./quote-provider-onvista";
import { eodhdFromEnvironment } from "./quote-provider-eodhd-config";

import { startFinanceImportWatcher } from "./import-pending";

// Prices come from Onvista. Yahoo answers a server's requests with 429
// whatever the rate (it wants a browser's TLS fingerprint), so it stays
// only as a choice: FINANCE_QUOTE_PROVIDER=yahoo. EODHD serves prices when
// chosen (FINANCE_QUOTE_PROVIDER=eodhd) and its token is set; news come
// from EODHD whenever the token is set, and are off otherwise.
{
  const eodhd = eodhdFromEnvironment();
  const choice = process.env.FINANCE_QUOTE_PROVIDER;
  setQuoteProvider(
    choice === "eodhd" && eodhd ? eodhd : choice === "yahoo" ? yahooQuoteProvider : onvistaQuoteProvider,
  );
  setNewsProvider(eodhd);
}

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
