/**
 * "Wofür sollte diese Reise vorsorgen?" (§7.2)
 *
 * The reporting half of the climate precautions. The buffer day the
 * planner already leaves empty; this says why it is empty, and answers
 * the other half of §7.2's sentence — whether the pool holds enough
 * that a rained-off morning has somewhere to go.
 *
 * It reports and does not act, which is the same shape the readiness
 * check has (§8.6) and for the same reason: a monthly average is a
 * reason to look, not a reason to rearrange somebody's holiday. Where
 * the pool is thin the answer says how many more sheltered candidates
 * it would take — a number somebody can do something about, rather than
 * "zu wenig".
 */

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { climateForLeg } from "./climate-precautions";
import { indoorReadiness } from "./climate-plan";
import { loadPlan, type StoredLeg } from "./plan-store";
import { shelterOf } from "./shelter";

export interface ClimateCheckRequest {
  planId: number;
  legIndex?: Query<number>;
}

export interface LegClimateReport {
  legIndex: number;
  legTitle: string | null;
  /** The month the normal was read for, or null when none applies. */
  month: number | null;
  /** Why this leg should prepare for something. Empty when it need not. */
  reasons: string[];
  /** Which day is deliberately empty, or null. */
  bufferDayIndex: number | null;
  /** What share of the pool is indoors or partly sheltered, 0…1. */
  indoorShare: number;
  /** What the month asks for, or null when it asks for nothing. */
  wantedIndoorShare: number | null;
  /** How many more sheltered candidates the pool would need. */
  shortfall: number;
  /** One sentence, or null when there is nothing to say. */
  sentence: string | null;
}

export interface ClimateCheckResponse {
  legs: LegClimateReport[];
}

export const climateCheck = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/climate", auth: true },
  async (req: ClimateCheckRequest): Promise<ClimateCheckResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const wanted = req.legIndex;
    const legs = wanted === undefined
      ? plan.legs
      : plan.legs.filter((leg) => leg.position === wanted);

    const reports: LegClimateReport[] = [];
    for (const leg of legs) {
      const climate = await climateForLeg({
        anchor: leg.anchor,
        startDate: leg.startDate,
        days: leg.days.length,
      });
      const readiness = indoorReadiness(sheltered(leg), climate.precautions.indoorShare);
      reports.push({
        legIndex: leg.position,
        legTitle: leg.title,
        month: climate.month,
        reasons: climate.precautions.reasons,
        bufferDayIndex: climate.bufferDay?.dayIndex ?? null,
        indoorShare: Math.round(readiness.share * 100) / 100,
        wantedIndoorShare: climate.precautions.indoorShare,
        shortfall: readiness.shortfall,
        sentence: sentenceFor(climate.precautions.reasons, readiness),
      });
    }
    return { legs: reports };
  },
);

/**
 * The one sentence, or none.
 *
 * A leg with nothing to prepare for says nothing at all: a screen that
 * reports "alles in Ordnung" about every leg of every trip trains
 * people to skip it, and then it is not there when it matters (§8.6).
 */
function sentenceFor(
  reasons: readonly string[],
  readiness: { enough: boolean; shortfall: number },
): string | null {
  if (reasons.length === 0) return null;
  if (readiness.enough) {
    return `${reasons.join(" ")} Der Vorrat hat genug, was auch bei Regen geht.`;
  }
  return `${reasons.join(" ")} Im Vorrat fehlen dafür etwa ${readiness.shortfall} Spots, `
    + "die auch bei Regen gehen — Museen, Markthallen, Kreuzgänge.";
}

/** The leg's pool, each entry with what the weather does to it (§7.2). */
function sheltered(leg: StoredLeg): Array<{ osmRef: string; shelter: string }> {
  return leg.pool.map((candidate) => ({
    osmRef: candidate.osmRef,
    shelter: shelterOf(candidate.category, candidate.kind ?? null),
  }));
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
