/**
 * Trip planner service.
 *
 * Turns constraints into a day of blocks filled with spots. The
 * candidate source is the geo service's area search (via osm-admin's
 * client); the arithmetic — budgets, walking estimates, selection and
 * ordering — lives here and is pure.
 *
 * See docs/ios-urlaubsplanung.md for the concept this implements.
 */

import { Service } from "encore.dev/service";

// Side-effect import: registers the endpoints on the service.
import "./plan";
import "./plans";
import "./interpret";
import "./corridor";
import "./food";
import "./visit";
import "./nearby";
import "./add-find";
import "./share";
import "./search";
import "./shares";
import "./pool";
import "./legs";
import "./spot-notes";

import { everyMs, schedule, startLocalCron } from "../lib/local-cron";
import { tickFillPending } from "./fill-pending";

// A trip planned for a place with no imported region is saved framed
// and empty, and the import that follows takes hours (§4.3). This is
// what fills those days in when it lands — a timer rather than a
// notification from the importer, because a multi-hour import does not
// care about a quarter of an hour, and a worker that owns its own
// schedule cannot be broken by an event that was never sent.
schedule({
  name: "trip-planner-fill-pending",
  description: "Fill in trips whose OSM region has finished importing.",
  service: "trip-planner",
  scheduleLabel: "every 15m",
  nextFire: everyMs(15 * 60_000),
  run: tickFillPending,
});

startLocalCron();

export default new Service("trip-planner");
