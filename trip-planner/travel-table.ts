/**
 * Travel times for one day's points, asked of the router once (§24).
 *
 * The solver asks for a leg hundreds of times while it tries orders,
 * and each answer has to be instant and pure — that is what lets a
 * day be re-planned offline and tested deterministically. So the
 * router is asked *before* the solver runs, for the whole set of
 * points at once (one matrix), and the solver reads from the table.
 * A pair the table does not have, a mode the router does not know, or
 * no router at all: the estimate from `travel.ts` answers, as it did
 * before, and the day says which it was (`source`).
 */

import { getRouterClient, type RouterClient } from "./router-client";
import { travelClassFor, travelLeg, type Coordinate, type TransportMode, type TravelLeg } from "./travel";

export type TravelSource = "router" | "estimate";

export interface TravelTable {
  /** Where the times came from — for the plan to say so (§9.5). */
  source: TravelSource;
  /** How many of the asked pairs the router answered. */
  answered: number;
  asked: number;
  travel(from: Coordinate, to: Coordinate, mode: TransportMode): TravelLeg;
}

/** The estimate alone, as a table: the shape every caller can rely on. */
export const ESTIMATE_TABLE: TravelTable = {
  source: "estimate",
  answered: 0,
  asked: 0,
  travel: travelLeg,
};

/** Above this many points a matrix costs more than it tells; the estimate serves. */
export const MAX_TABLE_POINTS = 120;

function key(c: Coordinate): string {
  return `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
}

/**
 * One matrix over `points` (every pair, both directions) for `mode`.
 * Returns the estimate table when the router is away, refuses the
 * mode, or the set is too large to be worth a matrix.
 */
export async function buildTravelTable(
  points: readonly Coordinate[],
  mode: TransportMode,
  router: RouterClient = getRouterClient(),
): Promise<TravelTable> {
  const unique = new Map<string, Coordinate>();
  for (const p of points) unique.set(key(p), { lat: p.lat, lon: p.lon });
  const list = [...unique.values()];
  if (list.length < 2 || list.length > MAX_TABLE_POINTS) return ESTIMATE_TABLE;

  const cells = await router.matrix(list, list, mode);
  if (!cells) return ESTIMATE_TABLE;

  const times = new Map<string, TravelLeg>();
  let answered = 0;
  list.forEach((from, i) => {
    list.forEach((to, j) => {
      const cell = cells[i]?.[j];
      if (!cell || i === j) return;
      answered++;
      times.set(`${key(from)}>${key(to)}`, {
        minutes: cell.minutes,
        distanceM: cell.distanceM,
        travelClass: travelClassFor(cell.minutes, mode),
      });
    });
  });
  const asked = list.length * (list.length - 1);
  if (answered === 0) return ESTIMATE_TABLE;

  return {
    source: "router",
    answered,
    asked,
    travel(from, to, legMode) {
      if (legMode !== mode) return travelLeg(from, to, legMode);
      return times.get(`${key(from)}>${key(to)}`) ?? travelLeg(from, to, legMode);
    },
  };
}
