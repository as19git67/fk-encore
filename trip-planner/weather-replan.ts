/**
 * Offering a day rearranged for the weather (§7.2, §7.1).
 *
 * The first place the planner *acts* on the weather rather than
 * reporting it — and it still does not act on its own. §7.1 settles
 * that: a redistribution is **offered**, never performed, because
 * "ungefragt umzuräumen wäre übergriffig". A forecast is an even
 * weaker reason to touch somebody's day than standing in the wrong
 * place at the wrong time, which is the case that rule was written
 * for.
 *
 * So two calls, and the split is the point:
 *
 *   - `POST …/weather/proposal` computes what it would do and saves
 *     nothing. The app shows the moves in plain words.
 *   - `POST …/weather/apply` does it, having been asked.
 *
 * The second recomputes rather than replaying the first. A proposal
 * held in the app for ten minutes while somebody thinks it over is a
 * proposal about a day that may since have changed — a stop ticked
 * off, a spot dropped, a newer forecast — and applying a stale plan is
 * how a day acquires a stop nobody chose.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { DEFAULT_MAX_WALK_MINUTES } from "./travel";
import { addDays } from "./leg-dates";
import { loadPlan, saveRedistribution, type StoredPlan } from "./plan-store";
import type { CurrentBlock } from "./redistribute";
import { hoursWithin, summarise, type BlockWeather } from "./weather";
import { forecastFor } from "./weather-service";
import { shuffleForWeather, type WeatherMove } from "./weather-shuffle";

export interface WeatherReplanRequest {
  planId: number;
  legIndex?: number;
  dayIndex: number;
  /** The destination's offset from UTC in minutes — see the light endpoint. */
  utcOffsetMinutes?: number;
}

export interface WeatherProposalResponse {
  /**
   * False when there is nothing to offer: no forecast, no dates, or a
   * day the weather has no quarrel with. A prompt that proposes
   * nothing teaches people to dismiss prompts.
   */
  offered: boolean;
  /** Why there is nothing to offer, for the screen to say out loud. */
  reason: "ok" | "no-dates" | "no-forecast" | "nothing-to-move";
  moves: WeatherMove[];
  /** The day as it would look. Not saved by this call. */
  blocks: CurrentBlock[];
}

export interface WeatherApplyResponse {
  plan: StoredPlan;
  /** What was actually done, recomputed at the moment of doing it. */
  moves: WeatherMove[];
}

export const weatherProposal = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/weather/proposal",
    auth: true,
  },
  async (req: WeatherReplanRequest): Promise<WeatherProposalResponse> => {
    const userId = requireUser();
    const prepared = await prepare(req, userId);
    if ("reason" in prepared) {
      return { offered: false, reason: prepared.reason, moves: [], blocks: [] };
    }

    const result = shuffleForWeather(prepared.request);
    return {
      offered: !result.unchanged,
      reason: result.unchanged ? "nothing-to-move" : "ok",
      moves: result.moves,
      blocks: result.blocks,
    };
  },
);

export const applyWeatherReplan = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/weather/apply",
    auth: true,
  },
  async (req: WeatherReplanRequest): Promise<WeatherApplyResponse> => {
    const userId = requireUser();
    const prepared = await prepare(req, userId);
    if ("reason" in prepared) {
      throw APIError.failedPrecondition(
        prepared.reason === "no-dates"
          ? "diese Reise hat noch kein Datum — ohne Tag gibt es keine Vorhersage"
          : "für diesen Tag gibt es keine Vorhersage",
      );
    }

    const result = shuffleForWeather(prepared.request);
    if (result.unchanged) {
      // Nothing to do is not an error, and rewriting the day to say so
      // would touch rows for no reason.
      return { plan: prepared.plan, moves: [] };
    }

    await saveRedistribution(
      prepared.plan.id,
      prepared.leg.id,
      prepared.day,
      result.blocks,
      result.pool,
    );

    const updated = await loadPlan(prepared.plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished while rearranging for the weather");
    return { plan: updated, moves: result.moves };
  },
);

type Prepared = {
  plan: StoredPlan;
  leg: StoredPlan["legs"][number];
  day: StoredPlan["legs"][number]["days"][number];
  request: Parameters<typeof shuffleForWeather>[0];
};

/**
 * Everything both calls need, fetched the same way by both.
 *
 * One function on purpose: the proposal and the change have to be
 * computed from identical inputs, or the app would show one thing and
 * save another.
 */
async function prepare(
  req: WeatherReplanRequest,
  userId: number,
): Promise<Prepared | { reason: "no-dates" | "no-forecast" }> {
  const plan = await loadPlan(req.planId, userId);
  if (!plan) throw APIError.notFound("plan not found");

  const legIndex = req.legIndex ?? 0;
  const leg = plan.legs.find((l) => l.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

  const day = leg.days.find((d) => d.dayIndex === req.dayIndex);
  if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in leg ${legIndex}`);
  if (!day.detailed) {
    // A day at trip resolution has a frame and no stops (§4.3). There
    // is nothing to rearrange, and half-planning it behind the
    // traveller's back would be the wrong way to start.
    throw APIError.failedPrecondition(
      "dieser Tag ist noch nicht ausgeplant — erst planen, dann nach dem Wetter umräumen",
    );
  }

  const offset = validateOffset(req.utcOffsetMinutes);
  if (leg.startDate === null) return { reason: "no-dates" };
  const date = addDays(leg.startDate, day.dayIndex);

  const { byDay } = await forecastFor(leg.anchor, [date]);
  const hours = byDay.get(date) ?? [];
  if (hours.length === 0) return { reason: "no-forecast" };

  const weather = new Map<string, BlockWeather>();
  for (const block of day.blocks) {
    if (block.startMinutes === null) continue;
    const summary = summarise(hoursWithin(
      hours, date, block.startMinutes, block.startMinutes + block.budgetMinutes, offset,
    ));
    if (summary) weather.set(block.id, summary);
  }
  if (weather.size === 0) return { reason: "no-forecast" };

  const maxWalkMinutes = typeof plan.constraints.maxWalkMinutes === "number"
    ? plan.constraints.maxWalkMinutes
    : DEFAULT_MAX_WALK_MINUTES;

  return {
    plan,
    leg,
    day,
    request: {
      blocks: day.blocks,
      pool: leg.pool,
      weather,
      anchor: leg.anchor,
      mode: leg.mode,
      maxWalkMinutes,
    },
  };
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
