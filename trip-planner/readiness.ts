/**
 * The evening before (§8.6).
 *
 * Between "der Plan steht" and the first travelling day sits the moment
 * where the mistakes that would ruin the whole thing are still cheap to
 * fix. §8.6 is explicit that this is **not new machinery**: it is a
 * list over states that already exist. That is also why it is worth
 * having — the two failures that actually spoil a trip, no map data
 * abroad and no ticket to hand, are both an evening's work to repair
 * and a catastrophe at the platform.
 *
 * Two of §8.6's four questions can be answered here today, and two
 * cannot. They are reported all the same, as `unknown` with the reason:
 * a check that quietly disappears is one nobody misses, and then
 * nobody notices that the app never looked. The two open ones are
 * tickets — documents are not linked to a trip yet (§3.4) — and votes,
 * which wait on the multi-user step (§6.1). The offline bundle (§3.9)
 * is answered by the device, because only the device knows what it has
 * stored; the app appends that row itself.
 *
 * The packing list comes along in the same answer, since it is derived
 * from the same plan and the same forecast (`packing.ts`).
 */

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { lightOfDay, validateOffset } from "./daylight";
import { addDays } from "./leg-dates";
import { packingList, type PackingDay, type PackingItem } from "./packing";
import { loadPlan, type StoredLeg } from "./plan-store";
import { shelterOf } from "./shelter";
import { hoursWithin, summarise } from "./weather";
import { forecastFor } from "./weather-service";

/** A day starts here when its blocks carry no clock (§8.3). */
const ASSUMED_DAY_START = 8 * 60;
const ASSUMED_DAY_END = 20 * 60;
/** From when a window counts as "abends" for the tripod rule (§8.6). */
const EVENING_FROM = 17 * 60;

export interface ReadinessRequest {
  planId: number;
  utcOffsetMinutes?: Query<number>;
}

export type CheckState = "ok" | "attention" | "unknown";

export interface ReadinessCheck {
  /** dates | region | detail | tickets | votes */
  id: string;
  state: CheckState;
  /** What to show, in words somebody can act on this evening. */
  sentence: string;
}

export interface ReadinessResponse {
  /** The trip's first day, or null when it has no dates yet. */
  startsOn: string | null;
  checks: ReadinessCheck[];
  packing: PackingItem[];
  /**
   * How far the forecast reached, as the last date it covered. Null
   * when none did — then the packing list is the part that needs no
   * weather, and the screen can say why it is short.
   */
  forecastUntil: string | null;
}

export const tripReadiness = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/readiness", auth: true },
  async (req: ReadinessRequest): Promise<ReadinessResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const offset = validateOffset(req.utcOffsetMinutes);
    const checks: ReadinessCheck[] = [];

    const dated = plan.legs.filter((leg) => leg.startDate !== null);
    const startsOn = dated.map((leg) => leg.startDate as string).sort()[0] ?? null;
    checks.push(startsOn === null
      ? {
        id: "dates",
        state: "attention",
        sentence: "Diese Reise hat noch kein Datum — ohne Tag gibt es keine Vorhersage und "
          + "keinen Countdown.",
      }
      : { id: "dates", state: "ok", sentence: `Es geht am ${startsOn} los.` });

    checks.push(await regionCheck(plan.legs));
    checks.push(detailCheck(plan.legs));

    // The two §8.6 questions this build cannot answer. Said out loud
    // rather than left out (§14, the bundle's `omits`).
    checks.push({
      id: "tickets",
      state: "unknown",
      sentence: "Tickets und Buchungen kann die App noch nicht prüfen: Dokumente hängen bisher "
        + "an keiner Reise.",
    });
    checks.push({
      id: "votes",
      state: "unknown",
      sentence: "Ob alle abgestimmt haben, kann die App noch nicht sagen — Abstimmungen kommen "
        + "mit dem Mehrbenutzerbetrieb.",
    });

    const { days, forecastUntil } = await packingDays(plan.legs, offset);
    const group = groupOf(plan.constraints);

    return {
      startsOn,
      checks,
      packing: packingList({ days, group }),
      forecastUntil,
    };
  },
);

/**
 * "Ist die Regionsdatenbank der ersten Etappe fertig importiert?"
 *
 * The worst failure §8.6 knows: without it there is no pool on the
 * ground, and nothing about it can be fixed once the group has left.
 * A leg still waiting is named, because "eine Etappe wartet noch" in a
 * trip through three cities is not actionable.
 */
async function regionCheck(legs: StoredLeg[]): Promise<ReadinessCheck> {
  const waiting: string[] = [];
  for (const leg of legs) {
    const name = leg.title ?? `Etappe ${leg.position + 1}`;
    if (leg.awaitingRegion) {
      waiting.push(name);
      continue;
    }
    const [row] = await db
      .select({ status: osmRegionImports.status })
      .from(osmRegionImports)
      .where(and(eq(osmRegionImports.postgres_db, leg.regionDb)))
      .limit(1);
    // No row at all is not "fine": it means nobody has imported the
    // region this leg was planned against.
    if (!row || !row.status.startsWith("ready")) waiting.push(name);
  }

  if (waiting.length === 0) {
    return { id: "region", state: "ok", sentence: "Die Karten aller Etappen sind da." };
  }
  return {
    id: "region",
    state: "attention",
    sentence: `Die Karten fehlen noch: ${waiting.join(", ")}. Vor Ort gibt es dort keinen Vorrat.`,
  };
}

/** Is the first day actually planned down to spots (§4.3)? */
function detailCheck(legs: StoredLeg[]): ReadinessCheck {
  const first = [...legs].sort((a, b) => a.position - b.position)[0];
  const firstDay = first?.days.find((day) => day.dayIndex === 0);
  if (!firstDay) {
    return { id: "detail", state: "attention", sentence: "Diese Reise hat noch keinen Tag." };
  }
  return firstDay.detailed
    ? { id: "detail", state: "ok", sentence: "Der erste Tag ist ausgeplant." }
    : {
      id: "detail",
      state: "attention",
      sentence: "Der erste Tag hat bisher nur seinen Rahmen — heute Abend ist der Moment, "
        + "ihn auszuplanen.",
    };
}

/**
 * Every day of the trip, reduced to what a packing rule may ask about.
 *
 * The forecast is fetched once per leg, for that leg's own dates: the
 * anchor decides the weather, and a trip through two cities has two
 * skies.
 */
async function packingDays(
  legs: StoredLeg[],
  offset: number,
): Promise<{ days: PackingDay[]; forecastUntil: string | null }> {
  const days: PackingDay[] = [];
  let forecastUntil: string | null = null;

  for (const leg of legs) {
    const dates = leg.startDate === null
      ? []
      : leg.days.map((day) => addDays(leg.startDate as string, day.dayIndex));
    const { byDay } = dates.length > 0
      ? await forecastFor(leg.anchor, dates)
      : { byDay: new Map<string, never[]>() };

    for (const day of leg.days) {
      if (!day.detailed) continue;
      const date = leg.startDate === null ? null : addDays(leg.startDate, day.dayIndex);
      const stops = day.blocks.flatMap((block) => block.stops);
      if (stops.length === 0) continue;

      const hours = date === null ? [] : byDay.get(date) ?? [];
      if (hours.length > 0 && (forecastUntil === null || (date as string) > forecastUntil)) {
        forecastUntil = date;
      }

      const from = day.blocks.reduce<number | null>(
        (earliest, block) => block.startMinutes === null
          ? earliest
          : Math.min(earliest ?? block.startMinutes, block.startMinutes),
        null,
      ) ?? ASSUMED_DAY_START;
      const until = day.blocks.reduce<number | null>(
        (latest, block) => block.startMinutes === null
          ? latest
          : Math.max(latest ?? 0, block.startMinutes + block.budgetMinutes),
        null,
      ) ?? ASSUMED_DAY_END;

      const weather = hours.length > 0 && date !== null
        ? summarise(hoursWithin(hours, date, from, until, offset))
        : null;

      days.push({
        date,
        label: date === null ? `Tag ${day.dayIndex + 1}` : `Am ${date}`,
        outdoorStops: stops.filter(
          (stop) => shelterOf(stop.category, stop.kind) === "outdoor",
        ).length,
        categories: [...new Set(stops.map((stop) => stop.category))],
        weather: weather === null
          ? null
          : {
            wetness: weather.wetness,
            heat: weather.heat,
            temperatureC: weather.temperatureC,
          },
        eveningLightForPhotoStop: hasEveningLightForAPhotoStop(leg, day, offset),
      });
    }
  }

  return { days, forecastUntil };
}

/**
 * A good window after five, and somebody standing in it on purpose.
 *
 * Both halves, because §7.3 keeps light a hint: a golden hour over a
 * day of museums is not a reason to carry a tripod for a fortnight.
 */
function hasEveningLightForAPhotoStop(
  leg: StoredLeg,
  day: StoredLeg["days"][number],
  offset: number,
): boolean {
  const marked = day.blocks.flatMap((block) => block.stops).some((stop) => stop.photoStop === true);
  if (!marked) return false;
  const light = lightOfDay(leg, day, offset);
  return light.windows.some(
    (window) => window.kind !== "harsh" && window.fromMinutes >= EVENING_FROM,
  );
}

function groupOf(constraints: Record<string, unknown>): {
  withChildren?: boolean;
  limitedMobility?: boolean;
} {
  const group = constraints.group;
  if (typeof group !== "object" || group === null) return {};
  const { withChildren, limitedMobility } = group as Record<string, unknown>;
  return {
    withChildren: withChildren === true,
    limitedMobility: limitedMobility === true,
  };
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
