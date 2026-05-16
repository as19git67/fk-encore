/**
 * Service boot for the OSM admin module (Epic #383).
 *
 * The osm-admin service owns the lifecycle of per-region Nominatim and
 * Overpass containers used for POI detection. Boot order:
 *
 *   1. Register the admin HTTP endpoints (side-effect import).
 *   2. Schedule the importer tick — every 30 s the worker advances at
 *      most one `importing` row toward `ready_running`. The job is
 *      naturally idle when no rows are in `importing`.
 *   3. Arm the local-cron scheduler (idempotent across services).
 *
 * The active docker driver defaults to `InMemoryDockerDriver` so this
 * file is safe to import in environments without a Docker socket. The
 * real dockerode-backed driver registers itself via `setDockerDriver`
 * in a follow-up slice; nothing here changes when it lands.
 */

import { Service } from "encore.dev/service";
import { everyMs, schedule, startLocalCron } from "../lib/local-cron";

console.log("[boot] osm-admin/encore.service.ts: begin");

// Side-effect import: registers the admin endpoints on the service.
import "./regions";
// Side-effect import: registers the per-region proxy endpoints.
import "./proxy";

import { tickImporter } from "./importer";
import { registerDockerodeDriverIfEnabled } from "./docker-driver.dockerode";

// Activate the dockerode driver iff explicitly requested via env. The
// default stays InMemoryDockerDriver so CI/test environments without
// a Docker socket keep working.
registerDockerodeDriverIfEnabled({
  defaultNetwork: process.env.OSM_ADMIN_DOCKER_NETWORK,
});

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
