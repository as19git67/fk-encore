/**
 * "Als Abendtermin einplanen?" (§7.3, third of the four ways)
 *
 * The one place where the minute-accurate light window is allowed to
 * become a time somebody can miss — and §7.3 is precise about how:
 * *"Eine Uhrzeit, die man verpassen kann, entsteht erst, wenn der
 * Nutzer Vorschlag 3 annimmt."* So this call only ever **says** a
 * sentence. Accepting it is the ordinary fixpoint call (§4.4), made by
 * a person, and everything that follows is the machinery that already
 * exists.
 *
 * What makes the sentence worth showing is that it is about a spot the
 * trip already knows and an evening the plan does not use: the day's
 * last block ends, the sun does not, and the terrace this family marked
 * as a photo stop is at its best half an hour later. Proposing that
 * costs nothing; planning it without asking would be the planner
 * inventing an appointment (§7.1).
 *
 * Deliberately silent in three cases, because a suggestion that comes
 * every day is a nag (§6.4): when nobody marked a photo stop, when the
 * best window falls inside a block that is already planned, and when
 * the light is merely harsh rather than good.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { addDays } from "./leg-dates";
import { spotLight } from "./light";
import { loadPlan, type StoredLeg, type StoredPlan } from "./plan-store";
import { spotLabel } from "./spot-label";
import { lightWindows, type LightWindow } from "./sun";
import { validateOffset } from "./daylight";
import type { Query } from "encore.dev/api";

/**
 * How long after the day's last block a window still counts as "this
 * evening". Beyond that it is tomorrow's problem, and a proposal for
 * 23:40 is one nobody wanted.
 */
const EVENING_REACH_MINUTES = 4 * 60;

/** Below this, the window is too short to be worth a trip out. */
const MIN_WINDOW_MINUTES = 15;

export interface EveningLightRequest {
  planId: number;
  legIndex?: Query<number>;
  dayIndex?: Query<number>;
  utcOffsetMinutes?: Query<number>;
}

export interface EveningLightProposal {
  osmRef: string;
  /** What to call it — never the OSM reference (§15.3). */
  label: string;
  /** The window, in the day's own clock. */
  from: string;
  to: string;
  fromMinutes: number;
  toMinutes: number;
  /** golden | blue — what kind of light this is. */
  kind: string;
  /** The sentence §7.3 writes, ready to show. */
  sentence: string;
  /** Where it is, so accepting can put a fixpoint there. */
  lat: number;
  lon: number;
}

export interface EveningLightResponse {
  /** The day this is about, or null when the trip has no dates. */
  date: string | null;
  /** Empty whenever there is nothing worth saying — the common case. */
  proposals: EveningLightProposal[];
}

export const eveningLight = api(
  {
    expose: true,
    method: "GET",
    path: "/trip-planner/plans/:planId/light/evening",
    auth: true,
  },
  async (req: EveningLightRequest): Promise<EveningLightResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const leg = legOf(plan, req.legIndex);
    const dayIndex = req.dayIndex ?? 0;
    const day = leg.days.find((d) => d.dayIndex === dayIndex);
    if (!day) throw APIError.notFound(`day ${dayIndex} not found in leg ${leg.position}`);
    if (leg.startDate === null) return { date: null, proposals: [] };

    const date = addDays(leg.startDate, dayIndex);
    const offset = validateOffset(req.utcOffsetMinutes);
    const windows = lightWindows(leg.anchor, date, offset);
    if (windows.length === 0) return { date, proposals: [] };

    // When the planned day is over. A day whose blocks carry no hour
    // has no evening to speak of either (§8.3).
    const dayEnds = endOfPlannedDay(day);
    if (dayEnds === null) return { date, proposals: [] };

    const proposals: EveningLightProposal[] = [];
    for (const spot of photoStops(leg)) {
      // The best window *this evening* — not the best of the day. A
      // west-facing wall is also lit at dawn, and proposing five in the
      // morning is not what §7.3 means by an evening block.
      const best = spotLight(leg.anchor, windows, spot.facadeAzimuth).find((lit) => {
        const { kind, fromMinutes, toMinutes } = lit.window;
        if (kind !== "golden" && kind !== "blue") return false;
        if (toMinutes - fromMinutes < MIN_WINDOW_MINUTES) return false;
        // Already covered by the plan: the group is out there anyway,
        // and saying so would be the app talking about its own day.
        if (fromMinutes < dayEnds) return false;
        return fromMinutes <= dayEnds + EVENING_REACH_MINUTES;
      });
      if (!best) continue;
      const window = best.window;

      const label = spotLabel(spot);
      proposals.push({
        osmRef: spot.osmRef,
        label,
        from: window.from,
        to: window.to,
        fromMinutes: window.fromMinutes,
        toMinutes: window.toMinutes,
        kind: window.kind,
        sentence: sentenceFor(label, window, best.facade),
        lat: spot.lat,
        lon: spot.lon,
      });
    }

    // One evening holds one outing. The best-lit spot is the one worth
    // naming; a list of five is a decision, and this is a hint.
    proposals.sort((a, b) => a.fromMinutes - b.fromMinutes);
    return { date, proposals: proposals.slice(0, 1) };
  },
);

/**
 * The sentence from §7.3, with the facade verdict when there is one.
 *
 * "ca." on purpose: the window is computed to the minute and the plan
 * stays coarse, and the wording is what keeps that from reading as an
 * appointment (§4.1).
 */
function sentenceFor(
  label: string,
  window: LightWindow,
  facade: string | null,
): string {
  const kind = window.kind === "golden" ? "im besten Licht" : "in der blauen Stunde";
  const how = facade === "frontal"
    ? " — die Sonne steht dann frontal darauf"
    : facade === "raking"
      ? " — die Sonne streift dann darüber"
      : "";
  return `${label} liegt heute von ca. ${clock(window.fromMinutes)} bis `
    + `${clock(window.toMinutes)} ${kind}${how}. Als Abendtermin einplanen?`;
}

function clock(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:`
    + `${String(wrapped % 60).padStart(2, "0")}`;
}

/** When the last block of the day is over, or null when none says. */
function endOfPlannedDay(day: StoredLeg["days"][number]): number | null {
  let latest: number | null = null;
  for (const block of day.blocks) {
    if (block.startMinutes === null) continue;
    const ends = block.startMinutes + block.budgetMinutes;
    if (latest === null || ends > latest) latest = ends;
  }
  return latest;
}

/**
 * The spots this trip marked as photo stops (§7.3) — planned or still
 * in the pool. The pool counts: the terrace nobody found room for is
 * exactly the one an evening is good for.
 */
interface PhotoStop {
  osmRef: string;
  name: string | null;
  category: string;
  kind?: string | null;
  lat: number;
  lon: number;
  facadeAzimuth: number | null | undefined;
}

function photoStops(leg: StoredLeg): PhotoStop[] {
  const found = new Map<string, PhotoStop>();
  const keep = (spot: {
    osmRef: string;
    name: string | null;
    category: string;
    kind?: string | null;
    lat: number;
    lon: number;
    facadeAzimuth?: number | null;
    photoStop?: boolean;
  }) => {
    if (spot.photoStop === true) {
      found.set(spot.osmRef, {
        osmRef: spot.osmRef,
        name: spot.name,
        category: spot.category,
        kind: spot.kind,
        lat: spot.lat,
        lon: spot.lon,
        facadeAzimuth: spot.facadeAzimuth,
      });
    }
  };
  for (const candidate of leg.pool) keep(candidate);
  for (const day of leg.days) {
    for (const block of day.blocks) {
      for (const stop of block.stops) keep(stop);
    }
  }
  return [...found.values()];
}

function legOf(plan: StoredPlan, legIndex: number | undefined): StoredLeg {
  const wanted = legIndex ?? 0;
  const leg = plan.legs.find((candidate) => candidate.position === wanted);
  if (!leg) throw APIError.notFound(`leg ${wanted} not found in this plan`);
  return leg;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
