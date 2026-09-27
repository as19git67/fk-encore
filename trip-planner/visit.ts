/**
 * Visits — HTTP endpoints (§6.4, §7.1).
 *
 * The device decides *that* a visit happened; this decides what to do
 * about it, and the split matters. Detection needs the position, and
 * the position stays on the phone — so what arrives here is an event
 * ("X was at Y from 13:40 to 14:20, because of a dwell and a photo")
 * and never a track.
 *
 * The verdict is recomputed here rather than trusted from the request.
 * Not because a device is hostile, but because the rule — one signal
 * asks, two act (§6.4) — is a product decision, and a product decision
 * that lives in two places drifts. `visits.ts` owns it.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { dayWalkOfStored } from "./day-walk";
import { MoveError, moveStop } from "./move";
import { loadPlan, saveMovedDays, setStopStatus } from "./plan-store";
import { answerVisit, listVisits, recordVisit, type StoredVisit } from "./visit-store";
import { placeVisitedStop } from "./visit-place";
import { assessVisit, isOnTheWay, type VisitVerdict } from "./visits";

export interface ReportVisitRequest {
  planId: number;
  /** The planned stop this confirms. Omit for an unplanned stay. */
  stopId?: number;
  /** Where it was. Required for an unplanned stay, ignored for a stop. */
  lat?: number;
  lon?: number;
  name?: string;
  osmRef?: string;
  /** ISO timestamps as the device recorded them. */
  arrivedAt: string;
  leftAt?: string;
  /** Minutes spent there, as the device measured them. */
  dwellMinutes?: number;
  /** A photo the POI matcher tied to this spot. */
  hasMatchingPhoto?: boolean;
  /** A receipt or card payment in the window. */
  hasPayment?: boolean;
  /** The traveller said so outright. */
  manual?: boolean;
  /**
   * The device's offset from UTC at the arrival, in minutes. With it, a
   * confirmed visit moves the stop into the block it happened in
   * (§8.5); without it — an older app — the stop is only ticked.
   */
  utcOffsetMinutes?: number;
}

export interface ReportVisitResponse {
  /** none | suggested | confirmed — see visits.ts for what each means. */
  verdict: VisitVerdict;
  /** How long the group had to stay for the dwell to count. */
  thresholdMinutes: number;
  /** Null when the verdict was `none`: nothing worth recording happened. */
  visit: StoredVisit | null;
}

/**
 * Report what the device observed at one spot.
 *
 * Returns the verdict as well as the row, because the app needs to know
 * whether to ask ("wart ihr hier?") or to say quietly that it ticked
 * something off — and that is the same distinction §6.4 draws.
 */
export const reportVisit = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/visits", auth: true },
  async (req: ReportVisitRequest): Promise<ReportVisitResponse> => {
    const userId = requireUser();

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const offset = validOffset(req.utcOffsetMinutes);
    const arrivedAt = validateTimestamp(req.arrivedAt, "arrivedAt");
    const leftAt = req.leftAt === undefined ? null : validateTimestamp(req.leftAt, "leftAt");
    if (leftAt !== null && leftAt < arrivedAt) {
      throw APIError.invalidArgument("leftAt cannot be before arrivedAt");
    }

    // A reported stop pins the visit to a place the plan already knows;
    // an unplanned stay has to bring its own coordinates.
    const stop = req.stopId === undefined ? null : findStop(plan, req.stopId);
    if (req.stopId !== undefined && !stop) {
      throw APIError.notFound(`stop ${req.stopId} not found in this plan`);
    }

    const lat = stop?.stop.lat ?? req.lat;
    const lon = stop?.stop.lon ?? req.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw APIError.invalidArgument(
        "an unplanned stay needs lat and lon — there is no stop to take them from",
      );
    }

    const assessment = assessVisit(
      {
        dwellMinutes: dwellMinutes(req, arrivedAt, leftAt),
        hasMatchingPhoto: req.hasMatchingPhoto,
        hasPayment: req.hasPayment,
        manual: req.manual,
      },
      {
        plannedDwellMinutes: stop?.stop.dwellMinutes ?? 0,
        onTheWay: stop ? isOnTheWay(stop.dayRefs, stop.stop.osmRef) : false,
      },
    );

    if (assessment.verdict === "none") {
      // Nothing worth recording. Saying so is the answer — writing a row
      // for every geofence crossing would turn the diary into a track.
      return {
        verdict: "none",
        thresholdMinutes: assessment.thresholdMinutes,
        visit: null,
      };
    }

    const visit = await recordVisit({
      planId: req.planId,
      userId,
      stopId: stop?.stop.rowId ?? null,
      osmRef: stop?.stop.osmRef ?? req.osmRef ?? null,
      name: stop?.stop.name ?? req.name ?? null,
      lat: lat as number,
      lon: lon as number,
      arrivedAt: arrivedAt.toISOString(),
      leftAt: leftAt?.toISOString() ?? null,
      sources: assessment.signals,
      confirmed: assessment.verdict === "confirmed",
    });

    // "Zwei Signale setzen den Status stumm" (§6.4) — the second half
    // of that sentence. The diary row alone left the stop "planned",
    // so a visit two signals agreed on still had to be ticked by hand.
    if (assessment.verdict === "confirmed" && stop) {
      await tickVisited(req.planId, userId, stop.stop.rowId, arrivedAt, offset);
    }

    return {
      verdict: assessment.verdict,
      thresholdMinutes: assessment.thresholdMinutes,
      visit: await reread(req.planId, userId, visit),
    };
  },
);

export interface ListVisitsResponse {
  visits: StoredVisit[];
}

/** The diary: every visit of a plan, oldest first. */
export const listTripVisits = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/visits", auth: true },
  async ({ planId }: { planId: number }): Promise<ListVisitsResponse> => {
    const userId = requireUser();
    const visits = await listVisits(planId, userId);
    if (visits === null) throw APIError.notFound("plan not found");
    return { visits };
  },
);

export interface AnswerVisitRequest {
  planId: number;
  visitId: number;
  /** True for "yes, we were there", false for "no". */
  confirmed: boolean;
  /** The device's offset from UTC, as on the report. */
  utcOffsetMinutes?: number;
}

/**
 * Answer "wart ihr hier?".
 *
 * A no is remembered rather than deleted: the same stay would otherwise
 * be re-detected on the next sync and offered again, which is the
 * nagging §6.4 exists to avoid.
 */
export const answerTripVisit = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/visits/answer", auth: true },
  async (req: AnswerVisitRequest): Promise<{ visit: StoredVisit }> => {
    const userId = requireUser();
    const offset = validOffset(req.utcOffsetMinutes);
    const visit = await answerVisit(req.planId, userId, req.visitId, req.confirmed === true);
    if (!visit) throw APIError.notFound("visit not found");
    // A yes is the tick: the answer was asked for exactly this.
    if (visit.confirmed && visit.stopId !== null) {
      await tickVisited(req.planId, userId, visit.stopId, new Date(visit.arrivedAt), offset);
    }
    return { visit: await reread(req.planId, userId, visit) };
  },
);

/**
 * Tick a stop the device saw visited, at the moment it was visited,
 * and put it in the block that moment falls in (§8.5).
 *
 * The tick carries the arrival rather than "now": the report comes when
 * the group leaves, the answer to "wart ihr hier?" whenever somebody
 * looks at the phone, and neither is when they were there.
 *
 * The move is the drag the travellers could have made themselves, done
 * by `moveStop` so the walks are recomputed the same way. It is left
 * out for the stop a frame placed (§7.3), whose block is at that hour
 * because of it, and for a split block (§6.5), whose stops belong to a
 * branch.
 */
async function tickVisited(
  planId: number,
  userId: number,
  stopId: number,
  arrivedAt: Date,
  utcOffsetMinutes: number | undefined,
): Promise<void> {
  await setStopStatus(planId, userId, stopId, "done", undefined, arrivedAt);
  if (utcOffsetMinutes === undefined) return;

  const plan = await loadPlan(planId, userId);
  if (!plan) return;
  for (const leg of plan.legs) {
    const sourceDay = leg.days.find((d) => d.blocks.some((b) => b.stops.some((s) => s.rowId === stopId)));
    if (!sourceDay) continue;
    const sourceBlock = sourceDay.blocks.find((b) => b.stops.some((s) => s.rowId === stopId))!;
    const osmRef = sourceBlock.stops.find((s) => s.rowId === stopId)!.osmRef;
    if (sourceBlock.branches.length > 0) return;
    if (sourceDay.fixpoints.some((f) => f.spotRef === osmRef && f.blockId)) return;

    const placement = placeVisitedStop({
      days: leg.days,
      startDate: leg.startDate,
      osmRef,
      arrivedAt: arrivedAt.toISOString(),
      utcOffsetMinutes,
    });
    if (!placement) return;
    const targetDay = leg.days.find((d) => d.dayIndex === placement.dayIndex)!;

    let moved;
    try {
      moved = moveStop({
        fromBlocks: sourceDay.blocks,
        toBlocks: sourceDay.id === targetDay.id ? sourceDay.blocks : targetDay.blocks,
        osmRef,
        toBlockId: placement.blockId,
        toPosition: placement.position,
        walk: dayWalkOfStored(leg.anchor, sourceDay),
        toWalk: dayWalkOfStored(leg.anchor, targetDay),
        mode: leg.mode,
      });
    } catch (err) {
      // The tick stands; only the move did not work out.
      if (err instanceof MoveError) return;
      throw err;
    }

    const days = sourceDay.id === targetDay.id
      ? [{ day: sourceDay, blocks: moved.fromBlocks }]
      : [{ day: sourceDay, blocks: moved.fromBlocks }, { day: targetDay, blocks: moved.toBlocks }];
    // The rewrite gives the stops new rows; the save keeps the
    // diary's links to them.
    await saveMovedDays(plan.id, days);
    return;
  }
}

/** The visit as it now reads, after a move may have relinked it. */
async function reread(planId: number, userId: number, visit: StoredVisit): Promise<StoredVisit> {
  const visits = await listVisits(planId, userId);
  return visits?.find((v) => v.id === visit.id) ?? visit;
}

function validOffset(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < -720 || value > 840) {
    throw APIError.invalidArgument("utcOffsetMinutes must be between -720 and 840");
  }
  return value;
}

/**
 * Prefer what the device measured; fall back to the two timestamps.
 * A stay still open has no duration yet, which is not zero — the group
 * is standing there right now.
 */
function dwellMinutes(
  req: ReportVisitRequest,
  arrivedAt: Date,
  leftAt: Date | null,
): number | undefined {
  if (typeof req.dwellMinutes === "number" && Number.isFinite(req.dwellMinutes)) {
    return Math.max(0, req.dwellMinutes);
  }
  if (!leftAt) return undefined;
  return Math.round((leftAt.getTime() - arrivedAt.getTime()) / 60_000);
}

/** The stop, plus the day's walking order, which the threshold needs. */
function findStop(
  plan: Awaited<ReturnType<typeof loadPlan>>,
  stopId: number,
): { stop: { rowId: number; osmRef: string; name: string | null; lat: number; lon: number; dwellMinutes: number }; dayRefs: string[] } | null {
  for (const leg of plan?.legs ?? []) {
    for (const day of leg.days) {
      const refs = day.blocks.flatMap((b) => b.stops.map((s) => s.osmRef));
      for (const block of day.blocks) {
        const stop = block.stops.find((s) => s.rowId === stopId);
        if (stop) return { stop, dayRefs: refs };
      }
    }
  }
  return null;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function validateTimestamp(value: string, label: string): Date {
  const date = typeof value === "string" ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) {
    throw APIError.invalidArgument(`${label} must be an ISO timestamp, got '${value}'`);
  }
  return date;
}
