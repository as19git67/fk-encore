/**
 * Whether a spot keeps the rain off (§7.2).
 *
 * The first bullet of §7.2, and the one everything else about weather
 * leans on: knowing it will rain is useless until you know which spots
 * mind. Derived from what OpenStreetMap already says — the planner's
 * own category, and the `kind` tag behind it — because a separate
 * attribute somebody has to maintain would be wrong within a month.
 *
 * Three values, not two. **Partly** is not a hedge: a market hall, a
 * castle ruin, a cloister genuinely are half outside, and forcing them
 * into one of the other two would either send a family into the rain
 * or waste the one dry hour of the afternoon indoors.
 *
 * `kind` beats the category where it disagrees. The category is coarse
 * on purpose — "sight" holds cathedrals and market squares alike — and
 * the tag is what a mapper actually wrote about that one place.
 */

export type Shelter = "indoor" | "partly" | "outdoor";

/** Categories that are indoors unless the tag says otherwise. */
const INDOOR_CATEGORIES: ReadonlySet<string> = new Set(["museum", "theatre", "cafe", "food"]);
/** Categories that are outdoors unless the tag says otherwise. */
const OUTDOOR_CATEGORIES: ReadonlySet<string> = new Set(["viewpoint", "outdoors"]);

/**
 * Tags that settle it, whatever the category says.
 *
 * Deliberately a short list of the cases that actually come up in a
 * planned day. Anything not here falls back to the category, and a
 * category nobody has an opinion about answers `partly` — which is the
 * honest shrug, not a default dressed up as knowledge.
 */
const BY_KIND: ReadonlyMap<string, Shelter> = new Map([
  ["tourism=museum", "indoor"],
  ["tourism=gallery", "indoor"],
  ["tourism=aquarium", "indoor"],
  ["amenity=theatre", "indoor"],
  ["amenity=cinema", "indoor"],
  ["amenity=library", "indoor"],
  ["building=church", "indoor"],
  ["amenity=place_of_worship", "indoor"],
  ["historic=castle", "partly"],
  ["historic=ruins", "outdoor"],
  ["historic=monument", "outdoor"],
  ["historic=memorial", "outdoor"],
  ["amenity=marketplace", "partly"],
  ["tourism=attraction", "partly"],
  ["tourism=viewpoint", "outdoor"],
  ["leisure=park", "outdoor"],
  ["leisure=garden", "outdoor"],
  ["tourism=zoo", "outdoor"],
  ["natural=peak", "outdoor"],
  ["natural=water", "outdoor"],
  ["natural=beach", "outdoor"],
]);

export function shelterOf(
  category: string | null | undefined,
  kind?: string | null,
): Shelter {
  const tagged = kind ? BY_KIND.get(kind) : undefined;
  if (tagged) return tagged;
  // Anything mapped as `natural=*` is outside, whatever follows the
  // equals sign — there is no indoor natural feature.
  if (kind?.startsWith("natural=")) return "outdoor";

  if (category && INDOOR_CATEGORIES.has(category)) return "indoor";
  if (category && OUTDOOR_CATEGORIES.has(category)) return "outdoor";
  return "partly";
}

/**
 * How much a spot minds the wet, from 0 (not at all) to 1 (entirely).
 *
 * A number rather than a branch because the reordering §7.2 asks for
 * has to rank spots against each other, and "indoor" and "partly" are
 * not equally good answers to a downpour.
 */
export function exposure(shelter: Shelter): number {
  switch (shelter) {
    case "indoor": return 0;
    case "partly": return 0.5;
    default: return 1;
  }
}
