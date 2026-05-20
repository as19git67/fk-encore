/**
 * Service boot for the OSM admin module.
 *
 * Owns the lifecycle of region imports against the geo service. Boot
 * order:
 *
 *   1. Register the admin HTTP endpoints (side-effect imports).
 *   2. Schedule the importer tick — every 30 s the worker polls the
 *      geo service for the next import's progress and advances at most
 *      one `importing` row toward `ready_running`.
 *   3. Arm the local-cron scheduler (idempotent across services).
 *
 * The geo service itself runs in its own container (see /geo); this
 * module only speaks to it over HTTP via `geo-client`.
 */

import { Service } from "encore.dev/service";
import { everyMs, schedule, startLocalCron } from "../lib/local-cron";

console.log("[boot] osm-admin/encore.service.ts: begin");

// Side-effect imports: register the admin endpoints on the service.
import "./regions";
import "./proxy";

import { tickImporter } from "./importer";

schedule({
  name: "osm-admin-importer",
  description: "Drive `importing` region rows toward `ready_running`.",
  service: "osm-admin",
  scheduleLabel: "every 30s",
  nextFire: everyMs(30_000),
  run: async () => {
    const outcome = await tickImporter();
    if (outcome.result !== "noop") {
      console.log(
        `[osm-admin] importer tick: slug=${outcome.slug} ` +
          `result=${outcome.result}${outcome.detail ? ` (${outcome.detail})` : ""}`,
      );
    }
  },
});

startLocalCron();

console.log("[boot] osm-admin/encore.service.ts: registering Service");
export default new Service("osm-admin");
console.log("[boot] osm-admin/encore.service.ts: end");
