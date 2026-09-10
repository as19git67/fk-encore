/**
 * What a climate normal is allowed to change (§7.2).
 *
 * Forecasts reach about a fortnight. A trip that starts in eight months
 * has none, and §7.2 is precise about what takes their place: *"Daraus
 * folgen keine Tagespläne, sondern Vorkehrungen: genug Indoor-Kandidaten
 * im Vorrat und ein nicht verplanter Puffertag je Etappe."*
 *
 * Both halves of that sentence are limits, not features:
 *
 *   - **No day plans.** A monthly average cannot say what Tuesday will
 *     do. Nothing here moves a spot, shortens a block or swaps a day —
 *     that is the forecast's work (`weather-shuffle.ts`), and only in
 *     the fortnight where a forecast exists.
 *   - **Precautions, and they are told rather than taken.** A buffer day
 *     is a day the planner leaves empty on purpose; the indoor share is
 *     a count the trip can be measured against. Both are stated with
 *     the reason, because "September in Japan" is a sentence somebody
 *     can argue with and a shrunken plan is not.
 *
 * Pure: a monthly normal and a leg's length in, precautions and
 * sentences out. No clock, no network, no database.
 */

/**
 * Above this share of wet days, a month counts as one to prepare for.
 * A third is where "it might rain" turns into "it will rain on some of
 * these days, and you do not know which".
 */
export const WET_MONTH_SHARE = 1 / 3;

/**
 * Above this monthly mean, heat is the thing to prepare for (§7.2:
 * "33 °C bei hoher Luftfeuchte verkürzt eine Tagesgehstrecke so
 * wirksam wie ein Regenguss"). A *mean* of 26 is a month of afternoons
 * well past thirty.
 */
export const HOT_MONTH_MEAN_C = 26;

/** Below this many days, a leg has no room to spare one (§7.2). */
export const MIN_LEG_DAYS_FOR_BUFFER = 3;

/**
 * How much of the pool should be usable in bad weather when the month
 * calls for it. Not "half the trip indoors" — a wet fortnight in Lisbon
 * is still a trip to Lisbon — but enough that a rained-off morning has
 * somewhere to go.
 */
export const WET_MONTH_INDOOR_SHARE = 0.3;

export interface ClimateNormalLike {
  month: number;
  meanTemperatureC: number;
  precipitationMm: number;
  /** Days in the month that see measurable rain. */
  wetDays: number;
}

export interface Precautions {
  /**
   * The share of the pool that should be indoor or partly sheltered,
   * or null when the month asks for nothing.
   */
  indoorShare: number | null;
  /** How many days of this leg to leave unplanned. Zero or one (§7.2). */
  bufferDays: number;
  /** Why, in words. Empty when there is nothing to prepare for. */
  reasons: string[];
}

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

/**
 * What this month asks a leg to prepare for.
 *
 * A month that is neither wet nor hot asks for nothing, and says so by
 * returning no reasons — the ordinary case, and the one where the
 * planner should stay quiet.
 */
export function precautionsFor(
  normal: ClimateNormalLike,
  legDays: number,
): Precautions {
  const reasons: string[] = [];
  const month = MONTHS[normal.month - 1] ?? `Monat ${normal.month}`;
  const share = wetShare(normal);

  const wet = share >= WET_MONTH_SHARE;
  const hot = normal.meanTemperatureC >= HOT_MONTH_MEAN_C;

  if (wet) {
    reasons.push(`Im ${month} ist dort etwa jeder ${Math.round(1 / share)}. Tag nass `
      + `(${Math.round(normal.wetDays)} Regentage, ${Math.round(normal.precipitationMm)} mm).`);
  }
  if (hot) {
    reasons.push(`Im ${month} liegt das Mittel bei ${Math.round(normal.meanTemperatureC)} °C — `
      + "die Mittagsstunden fallen dann als Gehzeit weitgehend aus.");
  }
  if (reasons.length === 0) {
    return { indoorShare: null, bufferDays: 0, reasons: [] };
  }

  // One day, never two: §7.2 says "ein Puffertag je Etappe", and a
  // planner that quietly empties a quarter of the holiday has stopped
  // being a planner.
  const bufferDays = legDays >= MIN_LEG_DAYS_FOR_BUFFER ? 1 : 0;
  if (bufferDays === 1) {
    reasons.push("Ein Tag der Etappe bleibt deshalb frei — als Puffer, nicht als Lücke.");
  } else {
    reasons.push("Für einen Puffertag ist diese Etappe zu kurz; er käme aus dem einzigen "
      + "Tag, den es gibt.");
  }

  return { indoorShare: WET_MONTH_INDOOR_SHARE, bufferDays, reasons };
}

/** The share of the month's days that see rain, between 0 and 1. */
export function wetShare(normal: ClimateNormalLike): number {
  const days = Math.max(0, Math.min(31, normal.wetDays));
  return days / 30;
}

export interface ShelteredCandidate {
  osmRef: string;
  /** indoor | partly | outdoor, from `shelter.ts`. */
  shelter: string;
}

/**
 * How much of this pool would survive a wet morning, and how much more
 * it would need.
 *
 * "Partly" counts: a covered market or a cloister is exactly what a
 * shower turns into the right idea, and demanding four walls would
 * report a shortfall the trip does not have.
 */
export function indoorReadiness(
  pool: readonly ShelteredCandidate[],
  wanted: number | null,
): { share: number; shortfall: number; enough: boolean } {
  if (pool.length === 0) {
    return { share: 0, shortfall: wanted === null ? 0 : 1, enough: wanted === null };
  }
  const sheltered = pool.filter((c) => c.shelter === "indoor" || c.shelter === "partly").length;
  const share = sheltered / pool.length;
  if (wanted === null) return { share, shortfall: 0, enough: true };
  const need = Math.ceil(wanted * pool.length);
  return { share, shortfall: Math.max(0, need - sheltered), enough: sheltered >= need };
}

/**
 * Which day of the leg to leave free.
 *
 * The middle, not the first and not the last: the first day is usually
 * an arrival and the last a departure, and a buffer that lands on
 * either is not spare time — it is the day that was already half gone.
 */
export function bufferDayIndex(legDays: number, bufferDays: number): number | null {
  if (bufferDays < 1 || legDays < MIN_LEG_DAYS_FOR_BUFFER) return null;
  return Math.floor((legDays - 1) / 2);
}
