/**
 * Service boot for the OSM admin module (Epic #383).
 *
 * The osm-admin service owns the lifecycle of per-region Nominatim and
 * Overpass containers used for POI detection. This file currently sets
 * up only the Encore service registration plus the placeholder admin
 * endpoints; the dockerode-driven container lifecycle, region importer,
 * and router are added in follow-up commits.
 */

import { Service } from "encore.dev/service";

console.log("[boot] osm-admin/encore.service.ts: begin");

// Side-effect import: registers the admin endpoints on the service.
import "./regions";

console.log("[boot] osm-admin/encore.service.ts: registering Service");
export default new Service("osm-admin");
console.log("[boot] osm-admin/encore.service.ts: end");
