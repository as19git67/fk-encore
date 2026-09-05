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
import { loadPlan } from "./plan-store";
import { answerVisit, listVisits, recordVisit, type StoredVisit } from "./visit-store";
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

    return {
      verdict: assessment.verdict,
      thresholdMinutes: assessment.thresholdMinutes,
      visit,
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
    const visit = await answerVisit(req.planId, userId, req.visitId, req.confirmed === true);
    if (!visit) throw APIError.notFound("visit not found");
    return { visit };
  },
);

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
