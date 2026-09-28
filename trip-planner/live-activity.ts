/**
 * Keeping the Lock Screen honest while the phone sleeps (§8.5).
 *
 * The app starts a Live Activity for the running day and computes its
 * content itself — on every wake it gets. Out of the first trial, that
 * is not enough: a phone lying still in a pocket gets no wake, and
 * "Mittag bis 14:00" stayed on the Lock Screen at dinner. The staleness
 * date made it *look* old; it did not make it right.
 *
 * So the app also hands the server the Activity's push token, and a
 * timer here recomputes the same content (`live-activity-content.ts`)
 * and pushes it whenever it changed — which, for the blocks, is at
 * their boundaries. When the day's last block is over the Activity is
 * ended and the row forgotten.
 *
 * The phone's own updates keep coming on every wake and are more
 * precise (a geofence knows which stop they are at, the clock only
 * guesses). The server only speaks when its own answer changed, so it
 * does not talk over the phone every five minutes.
 */

import { api, APIError } from "encore.dev/api";
import { and, eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripLiveActivities } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { apnsEnabled, sendLiveActivity, type ApnsSendResult } from "../push/apns-client";
import {
  isDeadToken,
  normaliseDeviceToken,
  parseEnvironment,
  type ApnsEnvironment,
  type LiveActivityPush,
} from "../push/apns-payload";
import { lightOfDay } from "./daylight";
import { storedHorizon } from "./horizon-store";
import { runningDayAt } from "./running-day";
import { loadPlan, type StoredPlan } from "./plan-store";
import {
  buildActivityContent,
  isTimeZone,
  staleDate,
  zonedClock,
  type ActivityContentState,
} from "./live-activity-content";

export interface RegisterLiveActivityRequest {
  planId: number;
  /** The Activity's push token, hex — not the device's. */
  token: string;
  /** production | sandbox, as for the device token. */
  environment?: string;
  /** The phone's IANA time zone, e.g. "Europe/Rome". */
  timeZone: string;
}

/**
 * Hand the server an Activity to keep current. Called by the app when
 * the Activity starts and whenever Apple rotates its token; the same
 * token again only refreshes the row.
 */
export const registerLiveActivity = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/live-activity", auth: true },
  async (req: RegisterLiveActivityRequest): Promise<{ registered: boolean }> => {
    const userId = requireUser();
    const token = normaliseDeviceToken(req.token);
    if (!token) throw APIError.invalidArgument("token must be the Activity's hex push token");
    if (typeof req.timeZone !== "string" || !isTimeZone(req.timeZone)) {
      throw APIError.invalidArgument("timeZone must be an IANA time zone such as Europe/Rome");
    }
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    await db
      .insert(tripLiveActivities)
      .values({
        user_id: userId,
        plan_id: plan.id,
        token,
        environment: parseEnvironment(req.environment),
        time_zone: req.timeZone,
      })
      .onConflictDoUpdate({
        target: tripLiveActivities.token,
        set: {
          user_id: userId,
          plan_id: plan.id,
          environment: parseEnvironment(req.environment),
          time_zone: req.timeZone,
        },
      });
    return { registered: true };
  },
);

/** The app ended the Activity itself; stop keeping it. */
export const endLiveActivity = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/live-activity/end", auth: true },
  async (req: { planId: number; token: string }): Promise<{ removed: boolean }> => {
    const userId = requireUser();
    const token = normaliseDeviceToken(req.token ?? "");
    if (!token) return { removed: false };
    const rows = await db
      .delete(tripLiveActivities)
      .where(and(eq(tripLiveActivities.token, token), eq(tripLiveActivities.user_id, userId)))
      .returning({ id: tripLiveActivities.id });
    return { removed: rows.length > 0 };
  },
);

/** How a tick reaches Apple. Replaceable in tests. */
export type LiveActivitySender = (
  token: string,
  env: ApnsEnvironment,
  push: LiveActivityPush,
) => Promise<ApnsSendResult>;

let sender: LiveActivitySender = sendLiveActivity;
let enabled: () => boolean = apnsEnabled;

export function setLiveActivitySender(next: LiveActivitySender | null, isEnabled?: () => boolean): void {
  sender = next ?? sendLiveActivity;
  enabled = isEnabled ?? (next ? () => true : apnsEnabled);
}

/**
 * A row is forgotten this long after it was made, whatever else
 * happened: an Activity lives a day, and a row that never saw the end
 * of its day (a plan without block times, a phone that went quiet)
 * must not be pushed at forever.
 */
export const MAX_AGE_MS = 30 * 60 * 60_000;

export interface TickResult {
  considered: number;
  sent: number;
  ended: number;
  removed: number;
}

/** What the running day says now, for one Activity; null when nothing. */
export async function contentFor(
  plan: StoredPlan,
  timeZone: string,
  now: Date,
): Promise<{ state: ActivityContentState | null; afterDay: boolean } | null> {
  const local = zonedClock(now, timeZone);
  // Date *and* time: a day with a journey holds three legs (§22.7).
  const running = runningDayAt(plan.legs, local.date, local.minutes);
  if (running && running.day.detailed) {
    const { leg, day } = running;
    const horizon = await storedHorizon(day.anchor ?? leg.anchor);
    const light = lightOfDay(leg, day, local.offsetMinutes, horizon);
    const state = buildActivityContent(day.blocks, local.minutes, light.spots);
    const ends = day.blocks.flatMap((b) => (b.startMinutes === null ? [] : [b.startMinutes + b.budgetMinutes]));
    const afterDay = ends.length > 0 && local.minutes >= Math.max(...ends);
    return { state, afterDay };
  }
  return null;
}

/**
 * One pass over every Activity the server keeps: push what changed,
 * end what is over, forget what Apple no longer knows.
 */
export async function tickLiveActivities(now: Date = new Date()): Promise<TickResult> {
  const result: TickResult = { considered: 0, sent: 0, ended: 0, removed: 0 };
  if (!enabled()) return result;

  const rows = await db.select().from(tripLiveActivities);
  for (const row of rows) {
    result.considered++;
    if (now.getTime() - Date.parse(row.created_at) > MAX_AGE_MS) {
      await remove(row.id);
      result.removed++;
      continue;
    }

    const plan = await loadPlan(row.plan_id, row.user_id);
    if (!plan) {
      await remove(row.id);
      result.removed++;
      continue;
    }

    const found = await contentFor(plan, row.time_zone, now);
    const env = parseEnvironment(row.environment);
    const last = (row.last_state ?? null) as ActivityContentState | null;

    if (found?.state) {
      if (last && sameState(last, found.state)) continue;
      const blockChanged = !last || last.blockLabel !== found.state.blockLabel;
      const answer = await sender(row.token, env, {
        event: "update",
        contentState: { ...found.state },
        staleDate: staleDate(found.state.blockEndMinutes, now, row.time_zone),
        timestamp: now,
        priority: blockChanged ? 10 : 5,
      });
      if (isDeadToken(answer.status, answer.reason)) {
        await remove(row.id);
        result.removed++;
        continue;
      }
      if (answer.status === 200) {
        await db
          .update(tripLiveActivities)
          .set({ last_state: found.state, last_sent_at: now.toISOString() })
          .where(eq(tripLiveActivities.id, row.id));
        result.sent++;
      }
      continue;
    }

    // Nothing to say. After the day's last block that means the day is
    // over: end the Activity and let go of it. Before the first block,
    // or in a gap without a block, there is simply nothing yet.
    if (found?.afterDay || found === null) {
      if (found === null && !last) continue; // not a day of this trip, never sent
      const answer = await sender(row.token, env, {
        event: "end",
        contentState: { ...(last ?? emptyState()) },
        dismissalDate: now,
        timestamp: now,
        priority: 5,
      });
      if (answer.status === 200 || isDeadToken(answer.status, answer.reason)) {
        await remove(row.id);
        result.ended++;
      }
    }
  }
  return result;
}

function sameState(a: ActivityContentState, b: ActivityContentState): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

function normalise(s: ActivityContentState): ActivityContentState {
  return {
    blockLabel: s.blockLabel ?? null,
    blockKind: s.blockKind ?? null,
    blockEndMinutes: s.blockEndMinutes ?? null,
    overrunMinutes: s.overrunMinutes ?? 0,
    currentStopName: s.currentStopName ?? null,
    stopConfirmed: s.stopConfirmed ?? false,
    nextStopName: s.nextStopName ?? null,
    lightHintText: s.lightHintText ?? null,
  };
}

function emptyState(): ActivityContentState {
  return {
    blockLabel: null, blockKind: null, blockEndMinutes: null, overrunMinutes: 0,
    currentStopName: null, stopConfirmed: false, nextStopName: null, lightHintText: null,
  };
}

async function remove(id: number): Promise<void> {
  await db.delete(tripLiveActivities).where(eq(tripLiveActivities.id, id));
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

