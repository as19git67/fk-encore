/**
 * Semantic POI categories for the planning search (`POST /pois/search`).
 *
 * The photo-matching lookup in `pois.ts` asks "what could this photo
 * show?" and therefore filters by raw OSM tags. Planning asks a
 * different question — "give me the museums in this area" — so it
 * needs categories a caller can name without knowing OSM tagging.
 *
 * Every tag referenced here MUST also be imported by the Lua filter in
 * `osm2pgsql.lua`; a category whose tags never reach `osm_pois` would
 * silently return nothing. `osm-admin/poi-tag-sync.test.ts` enforces
 * that invariant across the two files, so adding a category here fails
 * the test until the import knows about it.
 *
 * A word on the food categories: they exist so a caller can *find*
 * places to eat, not so the planner can recommend one. Open data knows
 * existence, not opinion — no quality, no popularity, no price level —
 * so the planner keeps lunch as a slot plus an area and leaves the
 * choice to the people eating (docs/ios-urlaubsplanung.md §10).
 */

/** A tag predicate: key must be present, and — unless `values` is
 *  omitted — hold one of the listed values. */
export interface CategoryTagRule {
  key: string;
  values?: readonly string[];
}

export interface PoiCategory {
  /** Stable identifier used in the API. */
  id: string;
  /** What a caller gets, in plain words — surfaced in the OpenAPI-ish docs. */
  description: string;
  /** OR-combined: a POI matches the category if any rule matches. */
  rules: readonly CategoryTagRule[];
  /**
   * What the category is *for*, which is not the same as what it
   * contains (§10.5).
   *
   * `visit` — somewhere you go because you want to see it. These are
   * what a day gets planned out of.
   *
   * `service` — what a trip runs on rather than admires: a pharmacy, a
   * cash machine, a supermarket. The concept is emphatic that this is
   * where open data is at its *best*, because existence is all anyone
   * needs — but it is a different question ("where is the nearest
   * chemist?") asked at a different moment. Planning a morning out of
   * these is how a savings bank ends up between two churches.
   */
  purpose: "visit" | "service";
}

export const POI_CATEGORIES: readonly PoiCategory[] = [
  {
    id: "sight",
    purpose: "visit",
    description: "Landmarks, monuments, castles, churches and other built attractions",
    rules: [
      { key: "tourism", values: ["attraction", "artwork", "monument"] },
      // `historic` on its own also matches every wayside cross, boundary
      // stone and commemorative plaque — thousands of them in a German
      // city, none of them somewhere you plan a morning around.
      {
        key: "historic",
        values: [
          "castle", "fort", "city_gate", "monument", "memorial", "ruins",
          "archaeological_site", "aqueduct", "manor", "palace", "tower",
          "church", "monastery", "mine", "ship", "locomotive", "aircraft",
        ],
      },
      { key: "building", values: ["castle", "cathedral", "church", "monastery", "palace"] },
      { key: "man_made", values: ["tower", "lighthouse", "bridge", "obelisk"] },
    ],
  },
  {
    id: "museum",
    purpose: "visit",
    description: "Museums and galleries — the indoor fallback on a wet block",
    rules: [{ key: "tourism", values: ["museum", "gallery"] }],
  },
  {
    id: "viewpoint",
    purpose: "visit",
    description: "Viewpoints, where the light window matters most",
    rules: [{ key: "tourism", values: ["viewpoint"] }],
  },
  {
    id: "worship",
    purpose: "visit",
    description: "Places of worship, often worth entering regardless of faith",
    rules: [{ key: "amenity", values: ["place_of_worship"] }],
  },
  {
    id: "theatre",
    purpose: "visit",
    description: "Theatres and opera houses",
    rules: [{ key: "amenity", values: ["theatre"] }],
  },
  {
    id: "food",
    purpose: "visit",
    description:
      "Places to eat — listed by distance and attributes, never ranked by quality (§10.3)",
    rules: [
      { key: "amenity", values: ["restaurant", "fast_food", "biergarten", "pub", "bar"] },
    ],
  },
  {
    id: "cafe",
    purpose: "visit",
    description: "Cafés, ice cream and bakeries — the short break between two spots",
    rules: [
      { key: "amenity", values: ["cafe", "ice_cream"] },
      { key: "shop", values: ["bakery"] },
    ],
  },
  {
    id: "essentials",
    purpose: "service",
    description:
      "What a trip runs on rather than admires: pharmacy, toilets, water, cash, groceries (§10.5)",
    rules: [
      { key: "amenity", values: ["pharmacy", "toilets", "drinking_water", "bank", "atm"] },
      { key: "shop", values: ["supermarket", "convenience"] },
    ],
  },
  {
    id: "outdoors",
    purpose: "visit",
    description: "Parks and playgrounds — where a block with children needs a pause",
    rules: [{ key: "leisure", values: ["park", "playground"] }],
  },
] as const;

const BY_ID = new Map(POI_CATEGORIES.map((c) => [c.id, c]));

export function categoryById(id: string): PoiCategory | undefined {
  return BY_ID.get(id);
}

export function allCategoryIds(): string[] {
  return POI_CATEGORIES.map((c) => c.id);
}

/**
 * The categories a day is planned out of — everything except the
 * service ones (§10.5).
 *
 * The default for a search that names no categories used to be *all* of
 * them, which quietly put pharmacies, cash machines and supermarkets in
 * the candidate pool for a sightseeing block. A caller that really
 * wants a chemist asks for `essentials` by name.
 */
export function visitCategoryIds(): string[] {
  return POI_CATEGORIES.filter((c) => c.purpose === "visit").map((c) => c.id);
}
