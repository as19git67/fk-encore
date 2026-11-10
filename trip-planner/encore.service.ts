/**
 * Trip planner service.
 *
 * Turns constraints into a day of blocks filled with spots. The
 * candidate source is the geo service's area search (via osm-admin's
 * client); the arithmetic — budgets, walking estimates, selection and
 * ordering — lives here and is pure.
 *
 * See documentation/ios-urlaubsplanung.md for the concept this implements.
 */

import { Service } from "encore.dev/service";
// Side-effect: attaches the shared secret to every outbound call to the
// internal Python services. See lib/internal-service-auth.ts.
import "../lib/internal-service-auth";

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
import "./explore";
import "./article-read";
import "./shares";
import "./pool";
import "./spot-gallery";
import "./spot-notes";
import "./daylight";
import "./forecast";
import "./weather-replan";
import "./weather-day-swap";
import "./climate";
import "./hidden-spots";
import "./to-pool";
import "./fixpoint-edit";
import "./day-anchor-edit";
import "./interest-list";
import "./day-blocks";
import "./bundle";
import "./readiness";
import "./review";
import "./ideas";
import "./idea-edit";
import "./map-link-read";
import "./outing";
import "./ideas-trip";
import "./documents";
import "./travellers";
import "./plan-votes";
import "./plan-ops";
import "./splits";
import "./light-evening";
import "./climate-check";
import "./transit-suggestion";
import "./home";
import "./live-activity";

import { everyMs, schedule, startLocalCron } from "../lib/local-cron";
import { tickFillPending } from "./fill-pending";
import { tickLiveActivities } from "./live-activity";
import { refillSpotFame } from "./spot-fame";
import { tickHighlights } from "./highlights-job";
import { describeSpots } from "./spot-description";
import { tickReturnOpen } from "./open-return";

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

// The Lock Screen while the phone sleeps (§8.5): recompute each running
// day's Live Activity and push it when it changed. Five minutes is the
// most a block boundary can be late by; a tick with nothing new sends
// nothing.
schedule({
  name: "trip-planner-live-activities",
  description: "Push running days' Live Activities when their block or stop changes.",
  service: "trip-planner",
  scheduleLabel: "every 5m",
  nextFire: everyMs(5 * 60_000),
  run: async () => {
    await tickLiveActivities();
  },
});

// What a pool build could not look up within its budget (ranking plan,
// stage 1): page views and the rest, for the next build of that city.
schedule({
  name: "trip-planner-spot-fame",
  description: "Look up page views, language editions, Commons and Wikivoyage for pool places still waiting.",
  service: "trip-planner",
  scheduleLabel: "every 30m",
  nextFire: everyMs(30 * 60_000),
  run: async () => {
    await refillSpotFame();
  },
});

// The local model's order of a stay's highlights (ideas plan, stage 2):
// one stay at a time, never on a request path. The name stays from the
// candidates' curation, which went with the searched pool.
schedule({
  name: "trip-planner-curation",
  description: "Let the local model order the highlights of stays that asked for them.",
  service: "trip-planner",
  scheduleLabel: "every 5m",
  nextFire: everyMs(5 * 60_000),
  run: async () => {
    await tickHighlights();
  },
});

// Text for a card where Wikipedia is thin (ranking plan, stage 4): the
// Wikipedia lead, else the place's own website summarised with a quote
// check. Wikivoyage lines need nothing; they come with the lookup.
schedule({
  name: "trip-planner-spot-descriptions",
  description: "Find a description for pool places: Wikipedia lead, else their own website.",
  service: "trip-planner",
  scheduleLabel: "every 30m",
  nextFire: everyMs(30 * 60_000),
  run: async () => {
    await describeSpots();
  },
});

// A soft stop "Tag füllen" put on a day that ended without it is an
// idea again (stage 8 of reise-planen-und-unterwegs.md). Half an hour
// after midnight where the stay is is soon enough: nobody plans
// tomorrow from yesterday's leftovers at ten past twelve.
schedule({
  name: "trip-planner-return-open",
  description: "Give soft stops their day did not reach back to the open spots of the stay.",
  service: "trip-planner",
  scheduleLabel: "every 30m",
  nextFire: everyMs(30 * 60_000),
  run: async () => {
    await tickReturnOpen();
  },
});

startLocalCron();

export default new Service("trip-planner");
