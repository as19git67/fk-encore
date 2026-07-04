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
 *   3. Schedule replication self-healing every five minutes and once shortly
 *      after boot. Only registered ready regions are considered.
 *   4. Arm the local-cron scheduler (idempotent across services).
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
import { runReplicationHealingPass } from "./replication-healer";

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

const replicationHealingEnabled = process.env.OSM_REPLICATION_HEALING !== "off";

async function runReplicationHealing(source: "startup" | "scheduled"): Promise<void> {
  const outcomes = await runReplicationHealingPass();
  for (const outcome of outcomes) {
    console.log(
      `[osm-admin] replication healing (${source}): result=${outcome.result}` +
        `${outcome.slug ? ` slug=${outcome.slug}` : ""}` +
        `${outcome.detail ? ` (${outcome.detail})` : ""}`,
    );
  }
}

if (replicationHealingEnabled) {
  schedule({
    name: "osm-admin-replication-healing",
    description: "Initialize missing replication state for registered OSM regions.",
    service: "osm-admin",
    scheduleLabel: "every 5m",
    nextFire: everyMs(5 * 60_000),
    run: () => runReplicationHealing("scheduled"),
  });

  // A short delay lets the geo container finish booting. The persisted lease
  // and advisory lock make this safe when several app replicas start together.
  const startupHealingTimer = setTimeout(() => {
    void runReplicationHealing("startup").catch((err) => {
      console.warn(`[osm-admin] startup replication healing failed: ${(err as Error).message}`);
    });
  }, 10_000);
  startupHealingTimer.unref?.();
}

startLocalCron();

console.log("[boot] osm-admin/encore.service.ts: registering Service");
export default new Service("osm-admin");
console.log("[boot] osm-admin/encore.service.ts: end");
