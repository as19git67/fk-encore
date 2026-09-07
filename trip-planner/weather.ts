/**
 * Turning an hourly forecast into something a plan can reason with
 * (§7.2).
 *
 * Three classes, not millimetres: **trocken / etwas Regen / nass**. A
 * plan built from half-day blocks cannot act on 0.4 mm versus 0.6 mm,
 * and pretending otherwise would put a precision in front of the
 * traveller that the forecast does not have either. Everything here is
 * arithmetic over numbers somebody else fetched — no request, no
 * database — so the thresholds are visible, testable and arguable in
 * one place.
 *
 * Heat is treated as the equal of rain, which §7.2 is explicit about:
 * 33 °C at high humidity shortens a day's walking as effectively as a
 * downpour, and a planner that only watches the rain sends a family
 * across a treeless square at two in the afternoon.
 */

/** How wet a stretch of the day is. */
export type WetnessClass = "dry" | "showers" | "wet";
/** How much the heat is in the way. */
export type HeatClass = "mild" | "warm" | "hot";

/**
 * Millimetres of precipitation over a block, and what to call it.
 *
 * The boundaries are deliberately low: what matters for planning is
 * not how much water falls but whether people put a hood up and stop
 * enjoying the outdoor spot. Half a millimetre in an afternoon is
 * already the difference between sitting on the square and not.
 */
const SHOWERS_MM = 0.2;
const WET_MM = 2;

export function wetness(precipitationMm: number): WetnessClass {
  if (!Number.isFinite(precipitationMm) || precipitationMm < SHOWERS_MM) return "dry";
  return precipitationMm >= WET_MM ? "wet" : "showers";
}

/**
 * The apparent temperature, by the standard heat index, in °C.
 *
 * Below 27 °C the formula is not defined and the answer is the
 * temperature itself — humidity does not make 18 °C feel warmer, and a
 * blind application of the polynomial down there produces nonsense.
 */
export function heatIndex(temperatureC: number, relativeHumidity: number): number {
  if (!Number.isFinite(temperatureC) || !Number.isFinite(relativeHumidity)) {
    return Number.isFinite(temperatureC) ? temperatureC : Number.NaN;
  }
  if (temperatureC < 27) return temperatureC;

  const t = temperatureC;
  const r = Math.min(Math.max(relativeHumidity, 0), 100);
  // Rothfusz regression, in Celsius.
  const index = -8.784695
    + 1.61139411 * t
    + 2.338549 * r
    - 0.14611605 * t * r
    - 0.012308094 * t * t
    - 0.016424828 * r * r
    + 0.002211732 * t * t * r
    + 0.00072546 * t * r * r
    - 0.000003582 * t * t * r * r;
  // The regression can dip below the dry-bulb temperature at the edge
  // of its domain; humidity never makes it cooler than it is.
  return Math.max(index, t);
}

const WARM_C = 28;
const HOT_C = 33;

export function heat(temperatureC: number, relativeHumidity: number): HeatClass {
  const felt = heatIndex(temperatureC, relativeHumidity);
  if (!Number.isFinite(felt) || felt < WARM_C) return "mild";
  return felt >= HOT_C ? "hot" : "warm";
}

export interface BlockWeather {
  /** Total precipitation over the block, in millimetres. */
  precipitationMm: number;
  wetness: WetnessClass;
  /** Mean cloud cover over the block, in percent. */
  cloudCover: number;
  /** Highest temperature in the block, in °C — the one that hurts. */
  temperatureC: number;
  relativeHumidity: number;
  /** Apparent temperature at that peak. */
  feelsLikeC: number;
  heat: HeatClass;
  /**
   * What is left of the block's budget once the weather is taken into
   * account, as a factor in (0, 1]. Reported here and applied nowhere
   * yet — see the endpoint.
   */
  budgetFactor: number;
}

/** One hour as the forecast delivers it. */
export interface ForecastHour {
  /** ISO-8601 instant, UTC. */
  time: string;
  precipitationMm: number;
  cloudCover: number;
  temperatureC: number;
  relativeHumidity: number;
}

/**
 * How much of a block's budget the weather leaves.
 *
 * Umbrellas, wet children and shade-hunting all cost time, and §7.2
 * asks for the budget to shrink rather than for spots to be dropped
 * silently. The factors multiply because a hot afternoon of rain is
 * worse than either alone, and the floor keeps the worst case a short
 * afternoon rather than an empty one: a plan that budgets nothing is
 * not a plan.
 */
const WETNESS_FACTOR: Readonly<Record<WetnessClass, number>> = {
  dry: 1,
  showers: 0.9,
  wet: 0.75,
};
const HEAT_FACTOR: Readonly<Record<HeatClass, number>> = {
  mild: 1,
  warm: 0.9,
  hot: 0.8,
};
const FLOOR = 0.6;

export function budgetFactor(wet: WetnessClass, hot: HeatClass): number {
  return Math.max(FLOOR, WETNESS_FACTOR[wet] * HEAT_FACTOR[hot]);
}

/**
 * Summarise the hours a block covers.
 *
 * Precipitation is summed because it accumulates; cloud cover is
 * averaged because it does not; temperature takes the **peak** rather
 * than the mean, since a block that reaches 34 °C for one hour is a
 * block people will remember as too hot.
 *
 * An empty list answers null rather than zeroes: "no data" and "dry
 * and mild" are different statements, and only one of them is true
 * when the forecast does not reach that far (§15.3).
 */
export function summarise(hours: readonly ForecastHour[]): BlockWeather | null {
  if (hours.length === 0) return null;

  let precipitation = 0;
  let cloud = 0;
  let peak = Number.NEGATIVE_INFINITY;
  let humidityAtPeak = 0;

  for (const hour of hours) {
    precipitation += Math.max(0, hour.precipitationMm);
    cloud += hour.cloudCover;
    if (hour.temperatureC > peak) {
      peak = hour.temperatureC;
      humidityAtPeak = hour.relativeHumidity;
    }
  }

  const wet = wetness(precipitation);
  const hot = heat(peak, humidityAtPeak);
  return {
    precipitationMm: Math.round(precipitation * 10) / 10,
    wetness: wet,
    cloudCover: Math.round(cloud / hours.length),
    temperatureC: Math.round(peak * 10) / 10,
    relativeHumidity: Math.round(humidityAtPeak),
    feelsLikeC: Math.round(heatIndex(peak, humidityAtPeak) * 10) / 10,
    heat: hot,
    budgetFactor: budgetFactor(wet, hot),
  };
}

/**
 * The hours of a day that fall inside a block's stretch of the clock.
 *
 * Both bounds are minutes past local midnight and the hours carry UTC
 * instants, so the offset has to come in with them; deriving it from
 * the longitude would be wrong across most of Europe (§7.3).
 */
export function hoursWithin(
  hours: readonly ForecastHour[],
  isoDay: string,
  fromMinutes: number,
  toMinutes: number,
  utcOffsetMinutes: number,
): ForecastHour[] {
  const midnight = Date.parse(`${isoDay}T00:00:00Z`) - utcOffsetMinutes * 60_000;
  const from = midnight + fromMinutes * 60_000;
  const to = midnight + toMinutes * 60_000;
  return hours.filter((hour) => {
    const at = Date.parse(hour.time);
    // The hour is stamped at its start and covers the hour that
    // follows, so one that begins before the block still counts when
    // it runs into it.
    return Number.isFinite(at) && at + 3_600_000 > from && at < to;
  });
}
