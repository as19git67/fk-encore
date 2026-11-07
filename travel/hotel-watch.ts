/**
 * Hotel price watches of the travel module (documentation/plans/reise-hotelpreise.md).
 *
 *   GET    /travel/hotel-watches             (travel.view)    own watches with their latest check
 *   GET    /travel/hotel-watches/:id         (travel.view)    one watch, its checks and newest rates
 *   POST   /travel/hotel-watches             (travel.manage)  create
 *   PUT    /travel/hotel-watches/:id         (travel.manage)  replace the criteria
 *   DELETE /travel/hotel-watches/:id         (travel.manage)  delete with its history
 *   POST   /travel/hotel-watches/:id/check   (travel.manage)  check now
 *   GET    /travel/hotel-search-status       (travel.view)    key configured, searches this month
 *   POST   /internal/travel/hotel-watches    the job (not exposed)
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { dailyAt, schedule } from "../lib/local-cron";
import {
  checkWatchNow,
  createWatch,
  deleteWatch,
  getWatchDetail,
  listWatches,
  maxEndDate,
  runDueChecks,
  searchesThisMonth,
  todayIso,
  updateWatch,
  type CheckRunResult,
  type HotelCheck,
  type HotelWatch,
  type HotelWatchDetail,
  type WatchInput,
} from "./hotel-watch.service";
import { hotelSearchClient, monthlySearchBudget } from "./serpapi-client";

/** The job checks every active watch once a day at this time (German time). */
export const CHECK_TIME = { hour: 6, minute: 0, timeZone: "Europe/Berlin" } as const;

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "module.travel");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

function requireClient() {
  const client = hotelSearchClient();
  if (!client) throw APIError.failedPrecondition("Kein SerpApi-Schlüssel eingerichtet (SERPAPI_API_KEY)");
  return client;
}

export const listHotelWatches = api(
  { expose: true, method: "GET", path: "/travel/hotel-watches", auth: true },
  async (): Promise<{ watches: HotelWatch[] }> => {
    const userId = requireUser("travel.view");
    return { watches: await listWatches(userId) };
  },
);

export const getHotelWatch = api(
  { expose: true, method: "GET", path: "/travel/hotel-watches/:id", auth: true },
  async ({ id }: { id: number }): Promise<HotelWatchDetail> => {
    const userId = requireUser("travel.view");
    return getWatchDetail(userId, id);
  },
);

export const createHotelWatch = api(
  { expose: true, method: "POST", path: "/travel/hotel-watches", auth: true },
  async (input: WatchInput): Promise<{ watch: HotelWatch }> => {
    const userId = requireUser("travel.manage");
    return { watch: await createWatch(userId, input) };
  },
);

interface UpdateRequest extends WatchInput {
  id: number;
}

export const updateHotelWatch = api(
  { expose: true, method: "PUT", path: "/travel/hotel-watches/:id", auth: true },
  async ({ id, ...input }: UpdateRequest): Promise<{ watch: HotelWatch }> => {
    const userId = requireUser("travel.manage");
    return { watch: await updateWatch(userId, id, input) };
  },
);

export const deleteHotelWatch = api(
  { expose: true, method: "DELETE", path: "/travel/hotel-watches/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    const userId = requireUser("travel.manage");
    await deleteWatch(userId, id);
    return { deleted: true };
  },
);

export const checkHotelWatch = api(
  { expose: true, method: "POST", path: "/travel/hotel-watches/:id/check", auth: true },
  async ({ id }: { id: number }): Promise<{ check: HotelCheck }> => {
    const userId = requireUser("travel.manage");
    return { check: await checkWatchNow(userId, id, requireClient()) };
  },
);

export interface HotelSearchStatus {
  configured: boolean;
  searches_this_month: number;
  monthly_budget: number;
  /** Wall-clock time of the daily check in Germany, "HH:MM". */
  check_time: string;
  /** Today and the latest end date a new watch may have. */
  today: string;
  max_end_date: string;
}

export const getHotelSearchStatus = api(
  { expose: true, method: "GET", path: "/travel/hotel-search-status", auth: true },
  async (): Promise<HotelSearchStatus> => {
    requireUser("travel.view");
    const today = todayIso();
    return {
      configured: hotelSearchClient() !== null,
      searches_this_month: await searchesThisMonth(),
      monthly_budget: monthlySearchBudget(),
      check_time: `${String(CHECK_TIME.hour).padStart(2, "0")}:${String(CHECK_TIME.minute).padStart(2, "0")}`,
      today,
      max_end_date: maxEndDate(today),
    };
  },
);

export const runHotelWatchJob = api(
  { expose: false, method: "POST", path: "/internal/travel/hotel-watches" },
  async (): Promise<CheckRunResult & { configured: boolean }> => {
    const client = hotelSearchClient();
    if (!client) return { configured: false, due: 0, checked: 0, failed: 0, skippedBudget: 0 };
    const result = await runDueChecks(client);
    console.log(
      `[travel.hotel-watch] due=${result.due} checked=${result.checked} failed=${result.failed} skipped_budget=${result.skippedBudget}`,
    );
    return { configured: true, ...result };
  },
);

schedule({
  name: "travel-hotel-watches",
  description: "Check the hotel price watches and write their price history (SerpApi Google Hotels)",
  service: "travel",
  scheduleLabel: "daily 06:00 Europe/Berlin",
  nextFire: dailyAt(CHECK_TIME.hour, CHECK_TIME.minute, CHECK_TIME.timeZone),
  run: () => runHotelWatchJob(),
});
