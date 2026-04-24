/**
 * Service boot for the finance module.
 *
 * Keeps itself minimal — no side-effect imports yet. Cron jobs join in
 * Etappe 6 (statements-cron), after the sync flow stabilises.
 *
 * Architecture: docs/finance-service-layout.md.
 */

import { Service } from "encore.dev/service";

console.log("[boot] finance/encore.service.ts: begin");

console.log("[boot] finance/encore.service.ts: registering Service");
export default new Service("finance");
console.log("[boot] finance/encore.service.ts: end");
