/**
 * What to put in the bag, derived from *this* plan (§8.6).
 *
 * The point of the packing list is what it is **not**: it is not "ten
 * things for Japan". Every line comes from something the plan already
 * says — an outdoor afternoon under a wet forecast, a church among the
 * stops, a golden window after six, a child in the group. A generic
 * list is a list nobody reads twice; a list of four lines that each
 * name the day they came from is one somebody acts on.
 *
 * So the rule for adding a rule here is strict: it must follow from
 * data the plan actually holds, and its sentence must say which day or
 * which stop produced it. Anything that would need a guess — "nimm
 * einen Adapter mit", which needs the country's sockets, or "Medikamente
 * nicht vergessen", which needs a person — belongs to somebody else's
 * list, not this one.
 *
 * Pure on purpose, like the other decision modules: days and their
 * weather in, items out. No clock, no network, no database — so the
 * same list can be computed on the device (§3.9) if it ever needs to be.
 */

import type { HeatClass, WetnessClass } from "./weather";

/** One day of the trip, reduced to what a packing rule can ask about. */
export interface PackingDay {
  /** The calendar date, for the sentence. Null for an undated trip. */
  date: string | null;
  /** Human label for the sentence — "Tag 3" when there is no date. */
  label: string;
  /** How much of the day is spent in the open (§7.2, `shelterOf`). */
  outdoorStops: number;
  /** Categories among the day's stops — "worship", "outdoors", … */
  categories: string[];
  /** What the sky is expected to do, or null where no forecast reaches. */
  weather: { wetness: WetnessClass; heat: HeatClass; temperatureC: number } | null;
  /**
   * True when the day has a good window in the evening *and* a spot
   * somebody marked as a photo stop (§7.3). Both halves matter: a
   * golden hour nobody planned to stand in is not a reason to carry a
   * tripod through a fortnight.
   */
  eveningLightForPhotoStop: boolean;
}

export interface PackingInput {
  days: PackingDay[];
  /** Who is travelling (§4.1) — the group scales more than budgets. */
  group?: { withChildren?: boolean; limitedMobility?: boolean };
}

export interface PackingItem {
  id: string;
  label: string;
  /** Which day or which stop asked for it, in plain words. */
  reason: string;
}

/** Below this, a jacket is a jacket rather than a preference, in °C. */
const COLD_C = 10;

/**
 * The list, in the order the reasons were found.
 *
 * Each rule fires at most once, and names the *first* day that caused
 * it: "Regenjacke — am 18.06. ist der Nachmittag draußen und nass" is
 * actionable; the same line repeated for six days is wallpaper.
 */
export function packingList({ days, group }: PackingInput): PackingItem[] {
  const items: PackingItem[] = [];
  const add = (id: string, label: string, reason: string) => {
    if (!items.some((item) => item.id === id)) items.push({ id, label, reason });
  };

  for (const day of days) {
    const weather = day.weather;
    const outdoors = day.outdoorStops > 0;

    // Rain only counts against time spent in the open. A wet day of
    // museums needs no rain jacket, and saying otherwise teaches people
    // that the list is guessing.
    if (weather && outdoors && weather.wetness !== "dry") {
      add("rain-jacket", "Regenjacke",
          `${day.label} ist draußen und ${weather.wetness === "wet" ? "nass" : "wechselhaft"}`);
    }

    if (weather && outdoors && weather.heat === "hot") {
      add("sun-hat", "Sonnenhut", `${day.label} wird heiß, und ihr seid im Freien`);
      add("water-bottle", "Wasserflasche", `${day.label} wird heiß, und ihr seid im Freien`);
    }

    if (weather && outdoors && weather.temperatureC < COLD_C) {
      add("warm-layer", "Warme Jacke",
          `${day.label} bleibt bei ${Math.round(weather.temperatureC)} °C draußen kühl`);
    }

    // A church, a mosque, a synagogue: many ask for covered shoulders
    // and long trousers, and OpenStreetMap does not say which. The
    // sentence is therefore a reminder, not a claim about the building.
    if (day.categories.includes("worship")) {
      add("modest-clothing", "Lange Hose oder langer Rock",
          `${day.label} steht ein Gotteshaus im Plan — viele erwarten bedeckte Schultern und Beine`);
    }

    if (day.eveningLightForPhotoStop) {
      add("tripod", "Stativ", `${day.label} liegt ein Fotostopp im Abendlicht`);
    }
  }

  if (group?.withChildren) {
    // Not weather-dependent and not a guess: somebody said there is a
    // child on this trip (§4.1).
    add("spare-clothes", "Wechselsachen", "ihr seid mit Kind unterwegs");
  }

  return items;
}
