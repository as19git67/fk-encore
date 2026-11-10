/**
 * "+ Tag n" in the spot picker (reise-planen-und-unterwegs.md, stage 4):
 * which day of a stay a place would go to if somebody just tapped.
 *
 * The first day that still has room for it and on which it is open.
 * "Room" is the free time `day-times.ts` computes on read; "open" is
 * `opening-hours.ts`, so a place whose hours nobody understands counts
 * as open — unknown is never "closed". When no day has room, the open
 * day with the most time left, marked `full`, so the button still says
 * where it would go and the day then shows "zu viel". Past days are
 * not offered. Nothing is written; the tap places it.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { DEFAULT_DWELL_MINUTES } from "./candidates";
import { addDays } from "./leg-dates";
import { openingOn } from "./opening-hours";
import { loadPlan, type StoredDay } from "./plan-store";
import { isStoppableJourney } from "./transit-leg";

/** More than a page of the picker has no reason to be asked at once. */
export const MAX_SUGGEST_SPOTS = 60;
/** A place without any duration of its own, as the name search offers it. */
const FALLBACK_DWELL_MINUTES = 45;

export interface SuggestSpot {
  osmRef: string;
  /** Taken from the idea when it is one; else this, else the category default. */
  dwellMinutes?: number;
  openingHours?: string | null;
  category?: string;
}

export interface SuggestDayRequest {
  planId: number;
  legIndex: number;
  spots: SuggestSpot[];
}

export interface DaySuggestion {
  osmRef: string;
  /** Within the stay, as everywhere else; null when no day is open. */
  dayIndex: number | null;
  /** The block it goes into on that day. */
  blockId: string | null;
  /** No day had room; this is the open one with the most time left. */
  full: boolean;
}

export interface SuggestDayResponse {
  suggestions: DaySuggestion[];
}

export interface DayForSuggestion {
  dayIndex: number;
  blocks: ReadonlyArray<{ id: string; kind: string }>;
  freeMinutes?: number;
}

/** The day for one place, from the stay's days as the plan reads them. */
export function suggestDay(
  days: readonly DayForSuggestion[],
  spot: { dwellMinutes: number; openingHours: string | null },
  opts: { startDate: string | null; today: string | null },
): Omit<DaySuggestion, "osmRef"> {
  let best: { day: DayForSuggestion; blockId: string; free: number } | null = null;
  for (const day of [...days].sort((a, b) => a.dayIndex - b.dayIndex)) {
    const block = day.blocks.find((b) => b.kind === "spots");
    if (!block) continue;
    const date = opts.startDate ? addDays(opts.startDate, day.dayIndex) : null;
    if (date && opts.today && date < opts.today) continue;
    if (date && openingOn(spot.openingHours, date).state === "closed") continue;
    // A day without a clock (an older trip) has room until it says otherwise.
    const free = day.freeMinutes ?? Number.POSITIVE_INFINITY;
    if (free >= spot.dwellMinutes) return { dayIndex: day.dayIndex, blockId: block.id, full: false };
    if (!best || free > best.free) best = { day, blockId: block.id, free };
  }
  return best
    ? { dayIndex: best.day.dayIndex, blockId: best.blockId, full: true }
    : { dayIndex: null, blockId: null, full: false };
}

export const suggestTripDay = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/legs/:legIndex/suggest-day", auth: true },
  async (req: SuggestDayRequest): Promise<SuggestDayResponse> => {
    const userId = requireUser();
    if (!Array.isArray(req.spots)) throw APIError.invalidArgument("spots must be a list");
    if (req.spots.length > MAX_SUGGEST_SPOTS) {
      throw APIError.invalidArgument(`at most ${MAX_SUGGEST_SPOTS} spots at once`);
    }
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    const leg = plan.legs.find((l) => l.position === req.legIndex);
    if (!leg) throw APIError.notFound(`leg ${req.legIndex} not found in this plan`);
    // A stop on the way goes onto the journey's one day (`transit-leg.ts`).
    if (leg.kind !== "stay" && !isStoppableJourney(leg)) {
      return { suggestions: req.spots.map((s) => ({ osmRef: s.osmRef, dayIndex: null, blockId: null, full: false })) };
    }
    const ideas = new Map(leg.pool.map((c) => [c.osmRef, c]));
    const today = new Date().toISOString().slice(0, 10);
    const days: StoredDay[] = leg.days;
    return {
      suggestions: req.spots.map((s) => {
        const idea = ideas.get(s.osmRef);
        const dwellMinutes = idea?.dwellMinutes
          ?? (validDwell(s.dwellMinutes) ? s.dwellMinutes! : undefined)
          ?? (s.category ? DEFAULT_DWELL_MINUTES[s.category] : undefined)
          ?? FALLBACK_DWELL_MINUTES;
        const openingHours = s.openingHours ?? idea?.openingHours ?? null;
        return {
          osmRef: s.osmRef,
          ...suggestDay(days, { dwellMinutes, openingHours }, { startDate: leg.startDate, today }),
        };
      }),
    };
  },
);

function validDwell(minutes: number | undefined): boolean {
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
