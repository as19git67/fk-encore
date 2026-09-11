import { Service } from "encore.dev/service";
import { startLocalCron } from "../lib/local-cron";
// Side-effect: registers DB persistence + realtime fan-out hooks for the
// scheduler before startLocalCron() runs.
import "../lib/scheduled-jobs-hooks";
// Side-effect: attaches the shared secret to every outbound call to the
// internal Python services. See lib/internal-service-auth.ts.
import "../lib/internal-service-auth";

// Expose API endpoints.
import "./meter";
import "./readings";
import "./import";
import "./api-keys";
import "./ingest";
import "./readings-ocr";
import "./reports";
import "./quick-entry";
// Side-effect: registers the daily anomaly job (Etappe 7).
import "./anomalies";
import "./reading-transactions";

// Arm the timers of the jobs registered above (Encore CronJobs do not fire
// in the self-hosted setup — see lib/local-cron.ts).
startLocalCron();

export default new Service("meter");
