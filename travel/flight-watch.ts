/**
 * Flight price watches of the travel module (documentation/plans/reise-flugpreise.md).
 *
 *   GET    /travel/flight-watches             (travel.view)    own watches with their latest check
 *   GET    /travel/flight-watches/:id         (travel.view)    one watch, its checks, flights, price history
 *   POST   /travel/flight-watches             (travel.manage)  create
 *   PUT    /travel/flight-watches/:id         (travel.manage)  replace the criteria
 *   DELETE /travel/flight-watches/:id         (travel.manage)  delete with its history
 *   POST   /travel/flight-watches/:id/check   (travel.manage)  check now
 *   POST   /internal/travel/flight-watches    the job (not exposed)
 *
 * Key, budget and today's limits come from `GET /travel/hotel-search-status`,
 * which both pages share: one SerpApi key, one monthly budget.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { dailyAt, schedule } from "../lib/local-cron";
import {
  checkFlightWatchNow,
  createFlightWatch,
  deleteFlightWatch,
  getFlightWatchDetail,
  listFlightWatches,
  runDueFlightChecks,
  updateFlightWatch,
  type FlightCheck,
  type FlightRunResult,
  type FlightWatch,
  type FlightWatchDetail,
  type FlightWatchInput,
} from "./flight-watch.service";
import { flightSearchClient } from "./flight-search-client";

/** A quarter of an hour after the hotels, so the two jobs do not race for the budget. */
export const FLIGHT_CHECK_TIME = { hour: 6, minute: 15, timeZone: "Europe/Berlin" } as const;

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "module.travel");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

export const listFlightWatchesApi = api(
  { expose: true, method: "GET", path: "/travel/flight-watches", auth: true },
  async (): Promise<{ watches: FlightWatch[] }> => {
    const userId = requireUser("travel.view");
    return { watches: await listFlightWatches(userId) };
  },
);

export const getFlightWatch = api(
  { expose: true, method: "GET", path: "/travel/flight-watches/:id", auth: true },
  async ({ id }: { id: number }): Promise<FlightWatchDetail> => {
    const userId = requireUser("travel.view");
    return getFlightWatchDetail(userId, id);
  },
);

export const createFlightWatchApi = api(
  { expose: true, method: "POST", path: "/travel/flight-watches", auth: true },
  async (input: FlightWatchInput): Promise<{ watch: FlightWatch }> => {
    const userId = requireUser("travel.manage");
    return { watch: await createFlightWatch(userId, input) };
  },
);

interface UpdateRequest extends FlightWatchInput {
  id: number;
}

export const updateFlightWatchApi = api(
  { expose: true, method: "PUT", path: "/travel/flight-watches/:id", auth: true },
  async ({ id, ...input }: UpdateRequest): Promise<{ watch: FlightWatch }> => {
    const userId = requireUser("travel.manage");
    return { watch: await updateFlightWatch(userId, id, input) };
  },
);

export const deleteFlightWatchApi = api(
  { expose: true, method: "DELETE", path: "/travel/flight-watches/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    const userId = requireUser("travel.manage");
    await deleteFlightWatch(userId, id);
    return { deleted: true };
  },
);

export const checkFlightWatchApi = api(
  { expose: true, method: "POST", path: "/travel/flight-watches/:id/check", auth: true },
  async ({ id }: { id: number }): Promise<{ check: FlightCheck }> => {
    const userId = requireUser("travel.manage");
    const client = flightSearchClient();
    if (!client) throw APIError.failedPrecondition("Kein SerpApi-Schlüssel eingerichtet (SERPAPI_API_KEY)");
    return { check: await checkFlightWatchNow(userId, id, client) };
  },
);

export const runFlightWatchJob = api(
  { expose: false, method: "POST", path: "/internal/travel/flight-watches" },
  async (): Promise<FlightRunResult & { configured: boolean }> => {
    const client = flightSearchClient();
    if (!client) return { configured: false, due: 0, checked: 0, failed: 0, skippedBudget: 0 };
    const result = await runDueFlightChecks(client);
    console.log(
      `[travel.flight-watch] due=${result.due} checked=${result.checked} failed=${result.failed} skipped_budget=${result.skippedBudget}`,
    );
    return { configured: true, ...result };
  },
);

schedule({
  name: "travel-flight-watches",
  description: "Check the flight price watches, one date combination each, and write their price history (SerpApi Google Flights)",
  service: "travel",
  scheduleLabel: "daily 06:15 Europe/Berlin",
  nextFire: dailyAt(FLIGHT_CHECK_TIME.hour, FLIGHT_CHECK_TIME.minute, FLIGHT_CHECK_TIME.timeZone),
  run: () => runFlightWatchJob(),
});
