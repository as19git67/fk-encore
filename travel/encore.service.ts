import { Service } from "encore.dev/service";
import { startLocalCron } from "../lib/local-cron";
// Side-effect: registers DB persistence + realtime fan-out hooks for the
// scheduler before startLocalCron() runs.
import "../lib/scheduled-jobs-hooks";

// Expose API endpoints; registers the hotel and flight price jobs.
import "./hotel-watch";
import "./flight-watch";

// Arm the timers of the jobs registered above (Encore CronJobs do not fire
// in the self-hosted setup — see lib/local-cron.ts).
startLocalCron();

// The travel module (Reise). Its first feature is the hotel price watch
// (documentation/plans/reise-hotelpreise.md); the trip planner stays in
// trip-planner/.
export default new Service("travel");
