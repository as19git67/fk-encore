/**
 * Suggesting a journey between two legs (§22.7, in the manner of §4.6).
 *
 * Measure, then say one thing, and write nothing: two dated places
 * after each other with no journey between them, far enough apart that
 * the drive is a morning or more — that is a day on which the planner
 * could find places on the way, and nobody has asked it to.
 *
 * The suggestion is the frame the journey screen opens with: leaving at
 * ten on the last day of the one place, arriving when the next one says
 * it expects the group (or after the drive and a margin for stops).
 * Accepting it is the ordinary `POST …/transits`; a "no" is the app's
 * to remember, because nothing was written that could be taken back.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { addDays } from "./leg-dates";
import { loadPlan } from "./plan-store";
import { travelLeg, type Coordinate, type TransportMode } from "./travel";

/** Below this a transfer is a transfer, not a day with a route. */
export const MIN_DRIVE_MINUTES = 120;
/** When the suggested journey sets off. */
const DEPART_MINUTES = 10 * 60;
/** Time for stops on top of the drive, when the next leg names no arrival. */
const STOP_MARGIN_MINUTES = 120;
/** Never suggest arriving later than this. */
const LATEST_ARRIVAL = 20 * 60;

export interface SuggestableLeg {
  position: number;
  kind?: "stay" | "transit";
  title: string | null;
  anchor: Coordinate;
  anchorLabel?: string | null;
  mode: TransportMode;
  startDate: string | null;
  arriveMinutes: number | null;
  days: readonly unknown[];
}

export interface TransitSuggestion {
  afterLegIndex: number;
  fromTitle: string;
  toTitle: string;
  departDate: string;
  departAt: string;
  arriveDate: string;
  arriveAt: string;
  mode: TransportMode;
  /** The drive alone, as the planner estimates it without a router. */
  driveMinutes: number;
  sentence: string;
}

/** The first pair of places that would be worth a journey, or null. */
export function suggestTransit(legs: readonly SuggestableLeg[]): TransitSuggestion | null {
  const ordered = [...legs].sort((a, b) => a.position - b.position);
  for (let i = 0; i + 1 < ordered.length; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    if (from.kind === "transit" || to.kind === "transit") continue;
    if (!from.startDate || !to.startDate || from.days.length === 0) continue;
    // Travelling on foot or by public transport, there is nothing the
    // planner could stop at on the way.
    const mode: TransportMode = to.mode === "bike" ? "bike" : "car";
    if (to.mode !== "car" && to.mode !== "bike" && from.mode !== "car") continue;

    const drive = travelLeg(from.anchor, to.anchor, mode).minutes;
    if (drive < MIN_DRIVE_MINUTES) continue;

    const departDate = addDays(from.startDate, from.days.length - 1);
    const arrive = to.arriveMinutes
      ?? Math.min(LATEST_ARRIVAL, DEPART_MINUTES + drive + STOP_MARGIN_MINUTES);
    if (arrive <= DEPART_MINUTES + drive) continue;

    const fromTitle = from.title ?? from.anchorLabel ?? `Etappe ${from.position + 1}`;
    const toTitle = to.title ?? to.anchorLabel ?? `Etappe ${to.position + 1}`;
    return {
      afterLegIndex: from.position,
      fromTitle,
      toTitle,
      departDate,
      departAt: clock(DEPART_MINUTES),
      arriveDate: departDate,
      arriveAt: clock(arrive),
      mode,
      driveMinutes: drive,
      sentence: `Von ${fromTitle} nach ${toTitle} sind es rund ${duration(drive)} `
        + `${mode === "bike" ? "mit dem Rad" : "mit dem Auto"}. Als Weiterreise geplant, `
        + "schlägt der Planer Orte am Weg vor, deren Umweg in den Tag passt.",
    };
  }
  return null;
}

export const transitSuggestion = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/transit-suggestion", auth: true },
  async ({ planId }: { planId: number }): Promise<{ suggestion: TransitSuggestion | null }> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "photos.view");
    const plan = await loadPlan(planId, parseInt(auth.userID, 10));
    if (!plan) throw APIError.notFound("plan not found");
    return { suggestion: suggestTransit(plan.legs) };
  },
);

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function duration(minutes: number): string {
  const rounded = Math.round(minutes / 10) * 10;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
}
