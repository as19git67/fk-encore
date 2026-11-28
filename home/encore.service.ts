import { Service } from "encore.dev/service";
import { startLocalCron } from "../lib/local-cron";
// Side-effect: registers DB persistence + realtime fan-out hooks for the
// scheduler before startLocalCron() runs.
import "../lib/scheduled-jobs-hooks";

// Expose API endpoints.
import "./systems";
import "./parts";
// Photo upload and delivery; side-effect: registers the nightly media sweep.
import "./media";

// Arm the timers of the jobs registered above (lib/local-cron.ts).
startLocalCron();

// The house module (Haus): a handbook of the house's technical systems —
// guides, items in place, notes, spare parts and their photos
// (documentation/plans/haus-anlagen.md). The meters stay their own module
// (meter/) and are linked from here.
export default new Service("home");
