/**
 * Trading a rainy day for a drier one (§7.2).
 *
 * The last of the three ways §7.2 lets the weather act, and the
 * largest: not a spot moved within a day, but a whole day's spots
 * moved to another date. The rule that makes it safe is the same one
 * the shuffle follows — **the frame stays with its day**. A block's
 * hours belong to the date (a departure at 17:45 does not move because
 * it rained), so only the stops change places, block for block, and
 * the walks are recomputed afterwards.
 *
 * Two calls again, for the reason §7.1 gives: a redistribution is
 * offered, never performed. The proposal saves nothing; the apply
 * recomputes rather than replaying it.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { addDays } from "./leg-dates";
import { loadPlan, saveRedistribution, type StoredPlan } from "./plan-store";
import { forecastFor } from "./weather-service";
import { hoursWithin, summarise } from "./weather";
import { swapRainyDay, type DaySwapReason, type WeatherDay } from "./weather-shuffle";

export interface WeatherDaySwapRequest {
  planId: number;
  legIndex?: number;
  /** The destination's offset from UTC in minutes — see the light endpoint. */
  utcOffsetMinutes?: number;
}

export interface WeatherDaySwapResponse {
  offered: boolean;
  /** Why there is nothing to offer, for the screen to say out loud. */
  reason: DaySwapReason;
  /** Day indexes within the leg, not row ids. */
  fromDayIndex: number | null;
  toDayIndex: number | null;
  /** The leg's days as they would look. Not saved by this call. */
  days: WeatherDay[];
}

export interface WeatherDaySwapApplyResponse {
  plan: StoredPlan;
  reason: DaySwapReason;
  fromDayIndex: number | null;
  toDayIndex: number | null;
}

export const weatherDaySwapProposal = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/weather/day-swap/proposal",
    auth: true,
  },
  async (req: WeatherDaySwapRequest): Promise<WeatherDaySwapResponse> => {
    const userId = requireUser();
    const prepared = await prepare(req, userId);
    const result = swapRainyDay(prepared);
    return {
      offered: result.reason === "ok",
      reason: result.reason,
      fromDayIndex: result.fromDayId,
      toDayIndex: result.toDayId,
      days: result.days,
    };
  },
);

export const weatherDaySwapApply = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/weather/day-swap/apply",
    auth: true,
  },
  async (req: WeatherDaySwapRequest): Promise<WeatherDaySwapApplyResponse> => {
    const userId = requireUser();
    const prepared = await prepare(req, userId);
    const result = swapRainyDay(prepared);

    if (result.reason === "ok") {
      for (const changed of result.days) {
        if (changed.id !== result.fromDayId && changed.id !== result.toDayId) continue;
        const stored = prepared.leg.days.find((day) => day.dayIndex === changed.id);
        if (!stored) continue;
        // The pool is not part of the trade: nothing left the plan, the
        // two days only exchanged what they hold.
        await saveRedistribution(
          prepared.plan.id,
          prepared.leg.id,
          stored,
          changed.blocks,
          prepared.leg.pool,
        );
      }
    }

    const plan = await loadPlan(prepared.plan.id, userId);
    if (!plan) throw APIError.internal("plan vanished while swapping weather days");
    return {
      plan,
      reason: result.reason,
      fromDayIndex: result.fromDayId,
      toDayIndex: result.toDayId,
    };
  },
);

type Prepared = Parameters<typeof swapRainyDay>[0] & {
  plan: StoredPlan;
  leg: StoredPlan["legs"][number];
};

async function prepare(req: WeatherDaySwapRequest, userId: number): Promise<Prepared> {
  const plan = await loadPlan(req.planId, userId);
  if (!plan) throw APIError.notFound("plan not found");

  const legIndex = req.legIndex ?? 0;
  const leg = plan.legs.find((candidate) => candidate.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);
  const startDate = leg.startDate;
  if (startDate === null) {
    throw APIError.failedPrecondition(
      "diese Reise hat noch kein Datum — ohne Tage gibt es nichts zu tauschen",
    );
  }

  const offset = validateOffset(req.utcOffsetMinutes);
  // Only days that are planned down to spots can trade: a day at trip
  // resolution has a frame and nothing in it (§4.3).
  const storedDays = leg.days.filter((day) => day.detailed);
  const days: WeatherDay[] = storedDays.map((day) => ({ id: day.dayIndex, blocks: day.blocks }));
  const base = { plan, leg, anchor: leg.anchor, mode: leg.mode };
  if (days.length < 2) return { ...base, days, weatherByDay: new Map() };

  const { byDay } = await forecastFor(
    leg.anchor,
    days.map((day) => addDays(startDate, day.id)),
  );

  const weatherByDay = new Map<number, number>();
  for (const day of storedDays) {
    const date = addDays(startDate, day.dayIndex);
    const hours = byDay.get(date) ?? [];
    if (hours.length === 0) continue;
    const values = day.blocks.flatMap((block) => {
      if (block.startMinutes === null) return [];
      const summary = summarise(hoursWithin(
        hours, date, block.startMinutes, block.startMinutes + block.budgetMinutes, offset,
      ));
      return summary ? [summary.wetness === "wet" ? 2 : summary.wetness === "showers" ? 1 : 0] : [];
    });
    // A day nobody could summarise stays out of the map entirely — it
    // is unknown weather, which is not the same as fine weather.
    if (values.length > 0) {
      weatherByDay.set(day.dayIndex, values.reduce((sum, value) => sum + value, 0) / values.length);
    }
  }

  return { ...base, days, weatherByDay };
}

function validateOffset(minutes: number | undefined): number {
  if (minutes === undefined) return 0;
  if (!Number.isFinite(minutes) || minutes < -12 * 60 || minutes > 14 * 60) {
    throw APIError.invalidArgument("utcOffsetMinutes must be between -720 and 840");
  }
  return Math.round(minutes);
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
