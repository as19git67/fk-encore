/**
 * How long a way takes (§4.7).
 *
 * The concept is exact about why this cannot be a category's business:
 * "Zehn Kilometer mit 600 Höhenmetern sind zu Fuß vier Stunden und mit
 * dem Rad eineinhalb. Keine Kategorie weiß das; die Strecke muss es
 * selbst sagen." A route imported from OpenStreetMap does say it — not
 * in hours, but in the two numbers hours follow from: how far it runs
 * and how much of it climbs.
 *
 * So this is not a guess dressed up as data. It is the arithmetic
 * walkers have used since long before OSM: the horizontal time and the
 * vertical time, of which you can do one at full speed and the other at
 * half. That is DIN 33466, and the reason it is worth using rather than
 * inventing something is that people recognise the answers — a walker
 * who knows the rule can see why the plan says three hours.
 *
 * **It is a starting number, not a verdict.** Whoever takes a route
 * into a trip can change the duration, and theirs wins from then on
 * (§9.2's note on the spot). Two groups with the same route walk it in
 * different times, and no formula settles that.
 *
 * What the formula *can* take account of is who is walking: the figures
 * below are an adult hiker's, and a group with a small child in it does
 * not walk them. `paceFactor` is that correction, worked out from the
 * travel group rather than from the route (`blocks.ts`,
 * `groupPaceFactor`) — because how fast you walk is a fact about the
 * walkers and not about the path.
 *
 * Pure: metres in, minutes out.
 */

import type { TransportMode } from "./travel";

/** Metres an hour, on the flat, per way of getting about. */
const FLAT_SPEED_M_PER_HOUR: Readonly<Record<string, number>> = {
  // The walking rule's own figure. Slower than a stroll on pavement,
  // because a signposted way is rarely pavement.
  foot: 4_000,
  // A touring pace on mixed surface, not a road cyclist's.
  bike: 15_000,
};

/** Metres of climb an hour. */
const CLIMB_M_PER_HOUR: Readonly<Record<string, number>> = {
  foot: 300,
  // Climbing is what levels a bike and a pair of boots: the wheels
  // help far less uphill than they do along.
  bike: 400,
};

/**
 * The slowest we will ever call a route, in minutes.
 *
 * A way of a few hundred metres is still somewhere you go and look at
 * something; calling it four minutes would put it in a block as though
 * it were nothing.
 */
export const MIN_ROUTE_MINUTES = 15;

/** Beyond this a route is not a block's worth, it is an expedition. */
export const MAX_ROUTE_MINUTES = 600;

/**
 * How long this way takes, in minutes.
 *
 * `ascentM` unknown counts as flat rather than as an unanswerable
 * question: most relations do not carry it, and a length alone still
 * says much more than a category would. The answer is then honestly
 * optimistic, which is why the traveller gets to change it.
 *
 * Modes other than foot and bike fall back on walking: a route
 * relation is a way you walk or ride, and a day by car that contains
 * one still contains it on foot.
 */
export function routeMinutes(
  lengthM: number,
  ascentM: number | null | undefined,
  mode: TransportMode = "foot",
  paceFactor = 1,
): number {
  const key = mode === "bike" ? "bike" : "foot";
  const length = Number.isFinite(lengthM) && lengthM > 0 ? lengthM : 0;
  const ascent = Number.isFinite(ascentM ?? NaN) && (ascentM ?? 0) > 0 ? (ascentM as number) : 0;

  const flatHours = length / FLAT_SPEED_M_PER_HOUR[key];
  const climbHours = ascent / CLIMB_M_PER_HOUR[key];

  // The rule of the two times: the greater at full value, the lesser
  // at half. You climb while you walk along, but not for nothing.
  const hours = Math.max(flatHours, climbHours) + Math.min(flatHours, climbHours) / 2;
  // Who is walking, applied to the whole rather than to the flat part
  // alone: a group that walks three kilometres an hour along also
  // climbs slower, and splitting the correction would claim a
  // precision nobody has measured.
  const pace = Number.isFinite(paceFactor) && paceFactor > 0 ? paceFactor : 1;
  const minutes = Math.round(hours * 60 * pace);
  return Math.min(MAX_ROUTE_MINUTES, Math.max(MIN_ROUTE_MINUTES, minutes));
}
