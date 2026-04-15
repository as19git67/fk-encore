import { Service } from "encore.dev/service";

/**
 * The `backup` service intentionally does NOT install the maintenance
 * middleware. Its own endpoints must remain reachable while a backup is
 * active so that the host-side script can always call
 * /internal/backup/stop to release the cluster.
 */
export default new Service("backup");
