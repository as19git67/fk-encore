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
 * All four of §8.6's questions can be answered here now. The last one
 * to arrive was the votes (§6.1), and it keeps the same honesty the
 * others have: it reports who has not said anything yet rather than a
 * percentage, because "haben alle abgestimmt" is a question about
 * people, and a number would hide which one is missing. A check that
 * cannot be answered is still reported as `unknown` with the reason —
 * one that quietly disappears is one nobody misses, and then nobody
 * notices that the app never looked. Tickets became answerable when
 * documents learned to hang off a trip (§3.4) — with the honest limit
 * that the app knows which papers are attached and not which ones
 * *ought* to be, so "nothing attached" is a question and not a verdict.
 * The offline bundle (§3.9) is answered by the device, because only the
 * device knows what it has stored; the app appends that row itself.
 *
 * The packing list comes along in the same answer, since it is derived
 * from the same plan and the same forecast (`packing.ts`).
 */

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import {
  osmRegionImports,
  tripPlanShares,
  tripPlanTravellers,
  users,
} from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { lightOfDay, validateOffset } from "./daylight";
import { addDays } from "./leg-dates";
import { linkedDocuments, suggestionsFor } from "./documents";
import { packingList, type PackingDay, type PackingItem } from "./packing";
import { loadPlan, type StoredLeg, type StoredPlan } from "./plan-store";
import { votesOfLeg } from "./vote-store";
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

    checks.push(await ticketCheck(plan, userId));
    checks.push(await voteCheck(plan));

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

/**
 * Are the tickets and bookings to hand as documents (§3.4, §8.6)?
 *
 * The honest shape of this answer matters more than the answer. The app
 * knows which papers somebody attached; it cannot know which ones the
 * trip *needs* — a weekend by car needs none, and there is no list of
 * required paperwork anywhere. So attached documents are reported as
 * `ok` and counted, and nothing attached is a question rather than a
 * verdict: `attention` when the suggestion list has candidates (they
 * exist, nobody linked them, and that is exactly the evening's cheap
 * fix), `unknown` when it has none, because then the app genuinely
 * does not know whether anything is missing.
 *
 * Documents nobody but their owner may read still count. The check
 * says how many are attached, never what they are — the trip is
 * shared, the paperwork is not.
 */
async function ticketCheck(plan: StoredPlan, userId: number): Promise<ReadinessCheck> {
  const linked = await linkedDocuments(plan.id, userId);
  if (linked.length > 0) {
    const named = linked
      .filter((doc) => doc.readable && doc.title)
      .map((doc) => doc.title as string);
    const what = named.length > 0 ? `: ${named.join(", ")}` : "";
    return {
      id: "tickets",
      state: "ok",
      sentence: linked.length === 1
        ? `Ein Dokument hängt an dieser Reise${what}.`
        : `${linked.length} Dokumente hängen an dieser Reise${what}.`,
    };
  }
  const { suggestions } = await suggestionsFor(plan, userId);
  if (suggestions.length > 0) {
    return {
      id: "tickets",
      state: "attention",
      sentence: suggestions.length === 1
        ? "Ein Dokument sieht nach dieser Reise aus und hängt noch nicht dran."
        : `${suggestions.length} Dokumente sehen nach dieser Reise aus und hängen noch nicht `
          + "dran.",
    };
  }
  return {
    id: "tickets",
    state: "unknown",
    sentence: "An dieser Reise hängt kein Dokument. Ob eines fehlt, weiß die App nicht — "
      + "sie kennt keine Liste dessen, was diese Reise braucht.",
  };
}

/**
 * "Haben alle abgestimmt, oder plant ihr an jemandem vorbei?" (§8.6)
 *
 * Names the people who have not said anything rather than counting
 * them: the point of the question is *who* is being planned past, and
 * "3 von 5 haben abgestimmt" is precisely the form of that answer which
 * nobody can act on.
 *
 * A trip nobody has voted on at all is not a warning — that is an
 * ordinary trip one person is planning, and §6 is explicit that it must
 * keep working. It becomes a question only once somebody has started:
 * a half-finished vote is what plans past the person who is missing.
 */
async function voteCheck(plan: StoredPlan): Promise<ReadinessCheck> {
  const votes = (await Promise.all(plan.legs.map((leg) => votesOfLeg(leg.id)))).flat();
  if (votes.length === 0) {
    return {
      id: "votes",
      state: "unknown",
      sentence: "Für diese Reise hat noch niemand abgestimmt — dann entscheidet, wer plant.",
    };
  }

  const spoke = new Set(votes.map((vote) => vote.voter));
  const silent: string[] = [];
  const participants = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [
      plan.ownerId,
      ...(await db
        .select({ id: tripPlanShares.user_id })
        .from(tripPlanShares)
        .where(eq(tripPlanShares.plan_id, plan.id))).map((row) => row.id),
    ]));
  for (const person of participants) {
    if (!spoke.has(`user:${person.id}`)) silent.push(person.name);
  }
  const travellers = await db
    .select({ id: tripPlanTravellers.id, label: tripPlanTravellers.label })
    .from(tripPlanTravellers)
    .where(eq(tripPlanTravellers.plan_id, plan.id));
  for (const traveller of travellers) {
    if (!spoke.has(`traveller:${traveller.id}`)) silent.push(traveller.label);
  }

  if (silent.length === 0) {
    return { id: "votes", state: "ok", sentence: "Alle haben abgestimmt." };
  }
  return {
    id: "votes",
    state: "attention",
    sentence: `Von ${silent.join(", ")} liegt noch keine Stimme vor — heute Abend ist der `
      + "Moment, danach zu fragen.",
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
