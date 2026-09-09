/**
 * Rearranging a day around the weather (§7.2).
 *
 * "Ein Regenblock zieht Indoor-Spots nach vorn und schiebt
 * Outdoor-Spots in den Vorrat — exakt die Mechanik aus §5, nur
 * automatisch ausgelöst." This is that mechanic, and the emphasis is
 * on *exakt*: the same rules that protect a day from redistribution
 * protect it from the weather.
 *
 *   - **Only planned, unpinned stops move.** A stop already done or
 *     skipped is the travel diary, not scheduling material, and a
 *     pinned one is a decision somebody made deliberately (§4.4, §5).
 *     Rain is not an argument against either.
 *   - **Displaced stops go to the pool, not the bin**, with the same
 *     boost §5 gives them, so they come back first on a drier day.
 *   - **Nothing is dropped that was not replaced by something better
 *     for the conditions.** A wet afternoon with two spots is a worse
 *     answer than a wet afternoon with two indoor spots.
 *
 * And one rule of its own: **this proposes, it never applies.** §7.1 is
 * explicit that a redistribution is offered rather than performed —
 * "ungefragt umzuräumen wäre übergriffig" — and a forecast is a weaker
 * reason to touch somebody's day than standing in the wrong place at
 * the wrong time. The caller shows the moves and asks.
 *
 * Pure: state in, state out, no clock and no database, so it runs on
 * the device in a dead spot like everything else in §5.
 */

import { recomputeDay } from "./move";
import { DISPLACEMENT_BOOST, type CurrentBlock, type CurrentStop } from "./redistribute";
import { exposure, shelterOf, type Shelter } from "./shelter";
import type { Candidate } from "./solver";
import { travelLeg, type Coordinate, type TransportMode } from "./travel";
import type { BlockWeather } from "./weather";

export interface WeatherShuffleRequest {
  blocks: readonly CurrentBlock[];
  /** The leg's pool — spots from another city are not replacements. */
  pool: readonly Candidate[];
  /** Per block id. A block with no forecast is left exactly as it is. */
  weather: ReadonlyMap<string, BlockWeather>;
  anchor: Coordinate;
  mode?: TransportMode;
  maxWalkMinutes: number;
}

export type MoveReason = "wet" | "budget";

export interface WeatherMove {
  osmRef: string;
  name: string | null;
  /** Where it was, and where it is proposed to go. Null means the pool. */
  fromBlockId: string;
  toBlockId: string | null;
  reason: MoveReason;
}

export interface WeatherShuffleResult {
  blocks: CurrentBlock[];
  pool: Candidate[];
  /** What the proposal would do, in the order it would do it. */
  moves: WeatherMove[];
  /**
   * True when nothing would change. The caller offers nothing rather
   * than offering a no-op, which is worse than silence: it teaches
   * people to dismiss the prompt.
   */
  unchanged: boolean;
}

/** One day of a leg, as the whole-day swap sees it. */
export interface WeatherDay {
  /** The day's index within the leg — how the plan addresses it. */
  id: number;
  blocks: readonly CurrentBlock[];
}

export interface WholeDaySwapRequest {
  days: readonly WeatherDay[];
  /**
   * Average rain severity per day: 0 dry, 1 showers, 2 wet. **A day
   * missing from this map has no forecast** and takes no part in the
   * exchange — neither as the wet day nor as the dry one it moves to.
   * Treating an unknown day as dry is how a plan ends up moved onto a
   * day nobody knows anything about (§15.3).
   */
  weatherByDay: ReadonlyMap<number, number>;
  /** Where both days start and end — the leg's anchor. */
  anchor: Coordinate;
  mode?: TransportMode;
}

export type DaySwapReason =
  | "ok"
  | "no-forecast"
  | "nothing-wet"
  | "nothing-drier"
  | "day-is-underway"
  | "different-frames";

export interface WholeDaySwapResult {
  days: WeatherDay[];
  fromDayId: number | null;
  toDayId: number | null;
  reason: DaySwapReason;
}

/**
 * Trade a wet day's spots for a drier day's (§7.2).
 *
 * "Ein Regentag verschiebt sich als Ganzes: was heute nass wäre, wird
 * auf einen trockenen Folgetag getauscht." The one thing that does
 * **not** travel with the spots is the day's frame. A frame belongs to
 * its date, not to its contents: the last train leaves on Thursday at
 * 17:45 whatever the weather does, and a departure day that inherited
 * Wednesday's full afternoon would describe hours nobody has (§4.4).
 * So the blocks stay where they are and only their stops change
 * places, matched by block, with the walks recomputed afterwards
 * because the order of the day has changed.
 *
 * Refused rather than half-done when the two days are not shaped
 * alike — a stop would have to be dropped to fit, and dropping it is a
 * decision for the traveller, not a side effect of the weather.
 *
 * Like everything else here: this proposes, the caller asks (§7.1).
 */
export function swapRainyDay(req: WholeDaySwapRequest): WholeDaySwapResult {
  const nothing = (reason: DaySwapReason): WholeDaySwapResult =>
    ({ days: req.days.map(copyDay), fromDayId: null, toDayId: null, reason });

  const known = req.days.filter((day) => req.weatherByDay.has(day.id));
  if (known.length < 2) return nothing("no-forecast");

  const score = (day: WeatherDay) => req.weatherByDay.get(day.id) ?? 0;
  const byWeather = [...known].sort((a, b) => score(b) - score(a) || a.id - b.id);
  const rainy = byWeather[0];
  const dry = byWeather[byWeather.length - 1];

  if (score(rainy) < 1) return nothing("nothing-wet");
  // A full class drier, or the exchange is churn: moving a showery
  // afternoon onto a slightly less showery one helps nobody.
  if (score(rainy) - score(dry) < 1) return nothing("nothing-drier");
  if (!allMovable(rainy) || !allMovable(dry)) return nothing("day-is-underway");
  if (!sameShape(rainy, dry)) return nothing("different-frames");

  const mode = req.mode ?? "foot";
  const swapped = new Map<number, WeatherDay>();
  const rainyCopy = copyDay(rainy);
  const dryCopy = copyDay(dry);
  const rainyStops = stopsByBlock(rainy);
  const dryStops = stopsByBlock(dry);

  fillFrom(rainyCopy, dryStops);
  fillFrom(dryCopy, rainyStops);
  recomputeDay(rainyCopy.blocks as CurrentBlock[], req.anchor, mode);
  recomputeDay(dryCopy.blocks as CurrentBlock[], req.anchor, mode);
  swapped.set(rainy.id, rainyCopy);
  swapped.set(dry.id, dryCopy);

  return {
    days: req.days.map((day) => swapped.get(day.id) ?? copyDay(day)),
    fromDayId: rainy.id,
    toDayId: dry.id,
    reason: "ok",
  };
}

/** Nothing on the day is done, skipped or pinned (§4.4, §5). */
function allMovable(day: WeatherDay): boolean {
  return day.blocks.every((block) => block.stops.every(movable));
}

/**
 * Both days hold their spots in blocks of the same name.
 *
 * Only blocks that actually carry stops have to match: a day with an
 * empty evening block can still trade with one that has none.
 */
function sameShape(a: WeatherDay, b: WeatherDay): boolean {
  const targets = (day: WeatherDay) => new Set(day.blocks.map((block) => block.id));
  const occupied = (day: WeatherDay) =>
    day.blocks.filter((block) => block.stops.length > 0).map((block) => block.id);
  return occupied(a).every((id) => targets(b).has(id))
    && occupied(b).every((id) => targets(a).has(id));
}

function stopsByBlock(day: WeatherDay): Map<string, CurrentStop[]> {
  return new Map(day.blocks.map((block) => [block.id, block.stops.map((stop) => ({ ...stop }))]));
}

function fillFrom(day: WeatherDay, stops: ReadonlyMap<string, CurrentStop[]>): void {
  for (const block of day.blocks as CurrentBlock[]) {
    block.stops = stops.get(block.id)?.map((stop) => ({ ...stop })) ?? [];
  }
}

function copyDay(day: WeatherDay): WeatherDay {
  return {
    ...day,
    blocks: day.blocks.map((block) => ({ ...block, stops: block.stops.map((stop) => ({ ...stop })) })),
  };
}

/**
 * How badly a block wants shelter, from 0 (not at all) to 1.
 *
 * Wet is the clear case. Showers count for half: worth swapping a
 * viewpoint out of, not worth emptying an afternoon over. Heat asks
 * for the same thing for a different reason — §7.2 puts a hot
 * afternoon beside a wet one deliberately — but asks less loudly,
 * because shade is easier to find than a roof.
 */
export function shelterWanted(weather: BlockWeather | undefined): number {
  if (!weather) return 0;
  const fromRain = weather.wetness === "wet" ? 1 : weather.wetness === "showers" ? 0.5 : 0;
  const fromHeat = weather.heat === "hot" ? 0.5 : weather.heat === "warm" ? 0.25 : 0;
  return Math.min(1, Math.max(fromRain, fromHeat));
}

/** What a block's budget becomes once the weather is counted (§7.2). */
export function weatheredBudget(block: CurrentBlock, weather: BlockWeather | undefined): number {
  if (!weather) return block.budgetMinutes;
  return Math.round(block.budgetMinutes * weather.budgetFactor);
}

/**
 * How well a spot suits a block's conditions. Higher is better.
 *
 * The spot's own score still decides between two equally suitable
 * places — the weather reorders a day, it does not overrule what the
 * travellers wanted.
 */
function fit(shelter: Shelter, wanted: number, score: number): number {
  return score - exposure(shelter) * wanted * 2;
}

function shelterOfStop(stop: { category: string; kind?: string | null }): Shelter {
  return shelterOf(stop.category, stop.kind);
}

function movable(stop: CurrentStop): boolean {
  return stop.status === "planned" && !stop.pinned;
}

/**
 * Propose a day rearranged for the weather.
 *
 * Built as an **exchange**, not as a re-plan. Emptying every block and
 * filling it again would also rearrange the halves of the day nobody
 * has a forecast for, and would quietly top up a dry afternoon from
 * the pool — which is the planner's job at planning time, not the
 * weather's at eight in the morning. So each spot that minds the
 * conditions is offered a swap, and everything else is left alone.
 */
export function shuffleForWeather(req: WeatherShuffleRequest): WeatherShuffleResult {
  const mode = req.mode ?? "foot";
  const blocks: CurrentBlock[] = req.blocks.map((block) => ({
    ...block,
    stops: block.stops.map((stop) => ({ ...stop })),
  }));
  const pool: Candidate[] = [...req.pool];
  const moves: WeatherMove[] = [];

  const wantedOf = (id: string) => shelterWanted(req.weather.get(id));

  // The blocks that would rather have something else, worst weather
  // first: the one with the least choice picks before the ones that
  // can take anything.
  const wanting = blocks
    .filter((block) => req.weather.has(block.id) && wantedOf(block.id) > 0)
    .sort((a, b) => wantedOf(b.id) - wantedOf(a.id));

  for (const block of wanting) {
    const wanted = wantedOf(block.id);
    // Worst-suited first, so the viewpoint leaves before the cloister.
    const exposed = block.stops
      .filter((stop) => movable(stop) && exposure(shelterOfStop(stop)) > 0)
      .sort((a, b) => exposure(shelterOfStop(b)) - exposure(shelterOfStop(a)));

    for (const stop of exposed) {
      const replacement = bestReplacement(stop, block, blocks, pool, req, wanted, mode);

      if (!replacement) {
        // Nothing better exists. In real rain the spot still goes back
        // to the pool — §7.2 says a wet block pushes outdoor spots out,
        // and standing at a viewpoint in a downpour is not a plan. Under
        // showers or heat it stays: half an hour of drizzle is not worth
        // emptying an afternoon over.
        if (wanted < 1) continue;
        remove(block, stop.osmRef);
        pool.push(displaced(stop));
        moves.push(move(stop, block.id, null, "wet"));
        continue;
      }

      remove(block, stop.osmRef);
      block.stops.push(asStop(replacement.candidate, replacement.leg));
      moves.push(move(replacement.candidate, replacement.fromBlockId ?? "", block.id, "wet"));

      if (replacement.fromBlockId === null) {
        // It came from the pool, so the displaced spot takes its place
        // there.
        const index = pool.findIndex((c) => c.osmRef === replacement.candidate.osmRef);
        if (index >= 0) pool.splice(index, 1);
        pool.push(displaced(stop));
        moves.push(move(stop, block.id, null, "wet"));
        continue;
      }

      // A straight swap with another block — provided the spot fits
      // where the replacement came from. If it does not, it goes to the
      // pool rather than overfilling somebody else's morning.
      const donor = blocks.find((b) => b.id === replacement.fromBlockId)!;
      remove(donor, replacement.candidate.osmRef);
      const leg = travelLeg(lastPosition(donor, req.anchor), stop, mode);
      const fits = leg.minutes <= req.maxWalkMinutes
        && used(donor) + stop.dwellMinutes + leg.minutes
          <= weatheredBudget(donor, req.weather.get(donor.id));
      if (fits) {
        donor.stops.push({ ...stop, travelFromPrevious: leg });
        moves.push(move(stop, block.id, donor.id, "wet"));
      } else {
        pool.push(displaced(stop));
        moves.push(move(stop, block.id, null, "wet"));
      }
    }

    // Whatever the weather left of the budget has to hold, or the card
    // would show a day nobody has time for.
    const budget = weatheredBudget(block, req.weather.get(block.id));
    while (used(block) > budget) {
      const worst = [...block.stops]
        .filter(movable)
        .sort((a, b) => a.score - b.score)[0];
      if (!worst) break;
      remove(block, worst.osmRef);
      pool.push(displaced(worst));
      moves.push(move(worst, block.id, null, "budget"));
    }
  }

  recomputeDay(blocks, req.anchor, mode);
  return { blocks, pool, moves, unchanged: moves.length === 0 };
}

interface Replacement {
  candidate: Candidate;
  /** Null when it came from the pool. */
  fromBlockId: string | null;
  leg: ReturnType<typeof travelLeg>;
}

/**
 * The best better-sheltered stand-in for `stop` in `block`.
 *
 * "Better sheltered" is the hard requirement — swapping one viewpoint
 * for another achieves nothing — and among those that qualify the
 * spot's own score still decides, because the weather reorders a day
 * rather than overruling what the travellers wanted.
 */
function bestReplacement(
  stop: CurrentStop,
  block: CurrentBlock,
  blocks: readonly CurrentBlock[],
  pool: readonly Candidate[],
  req: WeatherShuffleRequest,
  wanted: number,
  mode: TransportMode,
): Replacement | null {
  const mustBeat = exposure(shelterOfStop(stop));
  const offers: { candidate: Candidate; fromBlockId: string | null }[] = [
    ...pool.map((candidate) => ({ candidate, fromBlockId: null })),
    // Stops standing in blocks that mind the conditions less than this
    // one does. A museum in the dry morning is exactly the spot a wet
    // afternoon wants.
    ...blocks
      .filter((other) => other.id !== block.id && shelterWanted(req.weather.get(other.id)) < wanted)
      .flatMap((other) => other.stops
        .filter(movable)
        .map((candidate) => ({ candidate: stopToCandidate(candidate), fromBlockId: other.id }))),
  ];

  // The budget the block has once this spot has left it.
  const budget = weatheredBudget(block, req.weather.get(block.id));
  const without = used(block) - stop.dwellMinutes - stop.travelFromPrevious.minutes;
  const from = lastPositionWithout(block, stop.osmRef, req.anchor);

  let best: Replacement | null = null;
  let bestFit = Number.NEGATIVE_INFINITY;
  for (const offer of offers) {
    if (exposure(shelterOfStop(offer.candidate)) >= mustBeat) continue;
    const leg = travelLeg(from, offer.candidate, mode);
    if (leg.minutes > req.maxWalkMinutes) continue;
    if (without + offer.candidate.dwellMinutes + leg.minutes > budget) continue;

    const value = fit(shelterOfStop(offer.candidate), wanted, offer.candidate.score);
    if (value > bestFit) {
      bestFit = value;
      best = { candidate: offer.candidate, fromBlockId: offer.fromBlockId, leg };
    }
  }
  return best;
}

function used(block: CurrentBlock): number {
  return block.stops
    .filter((stop) => stop.status === "planned")
    .reduce((sum, stop) => sum + stop.dwellMinutes + stop.travelFromPrevious.minutes, 0);
}

function remove(block: CurrentBlock, osmRef: string): void {
  block.stops = block.stops.filter((stop) => stop.osmRef !== osmRef);
}

/** Back to the pool with the boost §5 gives anything it displaced. */
function displaced(stop: CurrentStop): Candidate {
  return { ...stopToCandidate(stop), score: stop.score + DISPLACEMENT_BOOST };
}

function move(
  spot: { osmRef: string; name: string | null },
  fromBlockId: string,
  toBlockId: string | null,
  reason: MoveReason,
): WeatherMove {
  return { osmRef: spot.osmRef, name: spot.name, fromBlockId, toBlockId, reason };
}

function lastPositionWithout(
  block: CurrentBlock,
  osmRef: string,
  anchor: Coordinate,
): Coordinate {
  const last = block.stops.filter((stop) => stop.osmRef !== osmRef).at(-1);
  return last ? { lat: last.lat, lon: last.lon } : anchor;
}

function lastPosition(block: CurrentBlock, anchor: Coordinate): Coordinate {
  const last = block.stops.at(-1);
  return last ? { lat: last.lat, lon: last.lon } : anchor;
}

function stopToCandidate(stop: CurrentStop): Candidate {
  return {
    osmRef: stop.osmRef,
    name: stop.name,
    localName: stop.localName ?? null,
    wikipediaUrl: stop.wikipediaUrl ?? null,
    facadeAzimuth: stop.facadeAzimuth ?? null,
    kind: stop.kind ?? null,
    lat: stop.lat,
    lon: stop.lon,
    category: stop.category,
    dwellMinutes: stop.dwellMinutes,
    score: stop.score,
  };
}

function asStop(candidate: Candidate, leg: ReturnType<typeof travelLeg>): CurrentStop {
  return {
    osmRef: candidate.osmRef,
    name: candidate.name,
    localName: candidate.localName ?? null,
    wikipediaUrl: candidate.wikipediaUrl ?? null,
    facadeAzimuth: candidate.facadeAzimuth ?? null,
    kind: candidate.kind ?? null,
    lat: candidate.lat,
    lon: candidate.lon,
    category: candidate.category,
    dwellMinutes: candidate.dwellMinutes,
    score: candidate.score,
    travelFromPrevious: leg,
    status: "planned",
    // Placed by the weather, not by a person: a later redistribution
    // may move it again, which is right — the forecast will have
    // changed by then too.
    pinned: false,
  };
}
