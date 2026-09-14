/**
 * Petrol price fetch endpoints (EU Weekly Oil Bulletin).
 *
 *   POST /meters/petrol-prices/fetch   (meters.manage)  fill missing months now
 *   POST /internal/meters/petrol-prices                 job entry point (not exposed)
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { dailyAtUtc, schedule } from "../lib/local-cron";
import {
  fillPetrolPricesForUser,
  loadMonthlyFuelPrices,
  userIdsWithChargingMeter,
  type FuelPriceFillResult,
} from "./fuel-prices.service";
import { OilBulletinUnavailableError } from "./oil-bulletin-client";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

export const fetchPetrolPrices = api(
  { expose: true, method: "POST", path: "/meters/petrol-prices/fetch", auth: true },
  async (): Promise<FuelPriceFillResult> => {
    const userId = requireUser("meters.manage");
    try {
      return await fillPetrolPricesForUser(userId);
    } catch (err) {
      // A Commission outage is `unavailable`, not an internal error.
      if (err instanceof OilBulletinUnavailableError) throw APIError.unavailable(err.message);
      throw err;
    }
  },
);

export interface PetrolPricesJobResult {
  users: number;
  monthsWritten: number;
  failures: number;
}

export const runPetrolPricesJob = api(
  { expose: false, method: "POST", path: "/internal/meters/petrol-prices" },
  async (): Promise<PetrolPricesJobResult> => {
    const result: PetrolPricesJobResult = { users: 0, monthsWritten: 0, failures: 0 };
    const audience = await userIdsWithChargingMeter();
    if (audience.length === 0) return result;

    // One download for everybody: the bulletin is a national series.
    let monthly;
    try {
      monthly = await loadMonthlyFuelPrices();
    } catch (err) {
      console.warn(`[meter.petrol-prices] ${err instanceof Error ? err.message : err}`);
      return { ...result, failures: 1 };
    }

    for (const userId of audience) {
      result.users += 1;
      try {
        const fill = await fillPetrolPricesForUser(userId, monthly);
        result.monthsWritten += fill.monthsWritten;
      } catch (err) {
        result.failures += 1;
        console.warn(
          `[meter.petrol-prices] user ${userId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    console.log(
      `[meter.petrol-prices] done: users=${result.users} written=${result.monthsWritten} failures=${result.failures}`,
    );
    return result;
  },
);

// Daily, like the degree days: the fill is a no-op until the bulletin has
// published enough weeks of a new month, and a household never has to
// remember to import anything. The bulletin appears on Thursdays, so a daily
// run picks a completed month up within a day of it becoming available.
schedule({
  name: "meter-petrol-prices",
  description: "Fetch monthly petrol prices from the EU Weekly Oil Bulletin for households with a wallbox meter",
  service: "meter",
  scheduleLabel: "daily 08:00 UTC",
  nextFire: dailyAtUtc(8, 0),
  run: () => runPetrolPricesJob(),
});
