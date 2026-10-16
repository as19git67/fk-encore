import { Service } from "encore.dev/service";
import { startLocalCron } from "../lib/local-cron";

// The hourly job that keeps rule collections current (#1548, stage 5).
import "./rules-cron";
// The hourly job that runs due scheduled exports (#1548, stage 9).
import "./schedules";

startLocalCron();

// Collections of any entity type (issue #1548). The document folder endpoints
// stay in the documents service; this service adds every other type and the
// view across all of them.
export default new Service("collections");
