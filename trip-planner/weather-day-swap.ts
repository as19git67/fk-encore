import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { addDays } from "./leg-dates";
import { loadPlan, saveRedistribution, type StoredPlan } from "./plan-store";
import { forecastFor } from "./weather-service";
import { hoursWithin, summarise } from "./weather";
import { swapRainyDay, type WeatherDay } from "./weather-shuffle";

export interface WeatherDaySwapRequest {
  planId: number;
  legIndex?: number;
  utcOffsetMinutes?: number;
}

export interface WeatherDaySwapResponse {
  offered: boolean;
  fromDayIndex: number | null;
  toDayIndex: number | null;
  days: WeatherDay[];
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
      offered: result.fromDayId !== null,
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
  async (req: WeatherDaySwapRequest) => {
    const userId = requireUser();
    const prepared = await prepare(req, userId);
    const result = swapRainyDay(prepared);
    if (result.fromDayId !== null && result.toDayId !== null) {
      for (const changed of result.days) {
        if (changed.id !== result.fromDayId && changed.id !== result.toDayId) continue;
        const original = prepared.days.find((day) => day.id === changed.id)!;
        await saveRedistribution(
          prepared.plan.id,
          prepared.leg.id,
          prepared.leg.days.find((day) => day.dayIndex === original.id)!,
          changed.blocks,
          prepared.leg.pool,
        );
      }
    }
    const plan = await loadPlan(prepared.plan.id, userId);
    if (!plan) throw APIError.internal("plan vanished while swapping weather days");
    return {
      plan,
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
  const leg = plan.legs.find((candidate) => candidate.position === (req.legIndex ?? 0));
  if (!leg) throw APIError.notFound("leg not found");
  if (!leg.startDate) throw APIError.failedPrecondition("diese Reise hat noch kein Datum");
  const storedDays = leg.days.filter((day) => day.detailed);
  const days: WeatherDay[] = storedDays.map((day) => ({ id: day.dayIndex, blocks: day.blocks }));
  if (days.length < 2) return { plan, leg, days: [], weatherByDay: new Map() };

  const dates = days.map((day) => addDays(leg.startDate!, day.id));
  const forecast = await forecastFor(leg.anchor, dates);
  const weatherByDay = new Map<number, number>();
  for (const storedDay of storedDays) {
    const hours = forecast.byDay.get(addDays(leg.startDate!, storedDay.dayIndex)) ?? [];
    const values = storedDay.blocks.flatMap((block) => {
      if (block.startMinutes === null) return [];
      const summary = summarise(hoursWithin(
        hours,
        addDays(leg.startDate!, storedDay.dayIndex),
        block.startMinutes,
        block.startMinutes + block.budgetMinutes,
        req.utcOffsetMinutes ?? 0,
      ));
      return summary ? [summary.wetness === "wet" ? 2 : summary.wetness === "showers" ? 1 : 0] : [];
    });
    if (values.length > 0) weatherByDay.set(storedDay.dayIndex, values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  return { plan, leg, days, weatherByDay };
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
