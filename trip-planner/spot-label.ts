/**
 * What to call a place the map never named (§15.3, §8.3).
 *
 * Most OpenStreetMap entries carry a name; some do not, and until now
 * those reached the screen as `way:213850482`. That is a reference, not
 * a name — nobody can vote on it, put it on a day, or recognise it
 * standing in front of it, and a list where a few rows are raw ids
 * teaches people to distrust the rest.
 *
 * The rule stays §15.3's: **never invent.** We do not guess what the
 * building is called; we say what the map does know — that it is a
 * church, a viewpoint, a market — and admit that the name is missing.
 * "Kirche (ohne Namen)" is honest, readable, and enough to decide by.
 * The reference is still carried in the data, because it is the handle
 * everything else uses; it just stops being what a person reads.
 */

/**
 * The categories the import produces (geo/src/poi-categories.ts), in
 * the singular a card needs. Kept here rather than in the geo package
 * because it is a matter of wording for the planner's screens, and the
 * import has no opinion about German grammar.
 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  sight: "Sehenswürdigkeit",
  museum: "Museum",
  viewpoint: "Aussichtspunkt",
  worship: "Kirche",
  theatre: "Theater",
  food: "Lokal",
  cafe: "Café",
  essentials: "Besorgung",
  outdoors: "Grünanlage",
  zoo: "Tierpark",
  market: "Markt",
  bath: "Bad",
  producers: "Hofladen",
};

/** "Kirche" for `amenity=place_of_worship`, when the category is coarse. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  "amenity=place_of_worship": "Kirche",
  "historic=castle": "Burg",
  "historic=ruins": "Ruine",
  "historic=memorial": "Denkmal",
  "historic=monument": "Denkmal",
  "man_made=tower": "Turm",
  "natural=peak": "Gipfel",
  "natural=water": "Gewässer",
  "natural=beach": "Strand",
  "leisure=park": "Park",
  "leisure=garden": "Garten",
  "leisure=nature_reserve": "Naturschutzgebiet",
  "tourism=viewpoint": "Aussichtspunkt",
  "tourism=museum": "Museum",
};

export interface LabelledSpot {
  osmRef: string;
  name?: string | null;
  category?: string | null;
  /** The OSM `key=value` tag, when the caller has it. */
  kind?: string | null;
}

/**
 * The line a person reads for this spot.
 *
 * The name when there is one — that is the ordinary case and this
 * changes nothing about it. Otherwise what the map does know, marked as
 * unnamed so nobody mistakes the category for a name. Only when even
 * that is missing does the reference appear, and then it is the truth:
 * the map has nothing to say about this place at all.
 */
export function spotLabel(spot: LabelledSpot): string {
  const name = spot.name?.trim();
  if (name) return name;

  const what = (spot.kind ? KIND_LABELS[spot.kind] : undefined)
    ?? (spot.category ? CATEGORY_LABELS[spot.category] : undefined);
  return what ? `${what} (ohne Namen)` : `Unbenannter Ort (${spot.osmRef})`;
}

/** True when the map never named this place. */
export function isUnnamed(spot: LabelledSpot): boolean {
  return !spot.name?.trim();
}
