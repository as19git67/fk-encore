import { Service } from "encore.dev/service";

console.log("[boot] backup/encore.service.ts: begin");

/**
 * The `backup` service intentionally does NOT install the maintenance
 * middleware. Its own endpoints must remain reachable while a backup is
 * active so that the host-side script can always call
 * /internal/backup/stop to release the cluster.
 */
console.log("[boot] backup/encore.service.ts: registering Service");
export default new Service("backup");
console.log("[boot] backup/encore.service.ts: end");
