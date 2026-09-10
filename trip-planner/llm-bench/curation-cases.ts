/**
 * The pool the curation is measured on (§11.3).
 *
 * §11.3 expects the biggest jump here: *"In 1M Kontext passt der
 * komplette Vorrat einer Stadt samt Wikipedia-Auszügen in **eine**
 * Anfrage, und heraus kommt eine begründete, thematisch ausgewogene
 * Auswahl: ‚diese 12 von 34, und warum'."* Today that job is done by a
 * weighted sum over OSM tags (`candidates.ts`).
 *
 * **The pool is invented, and that is deliberate.** A real city would
 * make the fixture a claim about real places — which building is worth
 * a morning, which church is "one of six much the same" — and a wrong
 * claim about a real place is worse than an honest fiction. Everything
 * here is a made-up town with made-up spots, and the labels say what
 * each one is *for the purpose of the measurement*.
 *
 * The pool is built around the four things a curation can get wrong,
 * each of which is countable:
 *
 *   - **Invention.** A ref that was not in the pool (§10.4).
 *   - **The everyday.** Things that exist rather than things you go to
 *     see. Two of them carry a Wikipedia article, because that is
 *     exactly where the weighted sum is blind: a listed savings bank
 *     scores like a cathedral.
 *   - **Monotony.** Six near-identical parish churches, all with
 *     articles. A tag-based score has no reason to prefer one over the
 *     next and will take them all; a reader notices that a day of six
 *     village churches is not a day.
 *   - **The group.** The request says a seven-year-old is along. Some
 *     entries are labelled as poor for that, and picking them is a
 *     miss no tag captures.
 */

import type { GeoPoiSearchSpot } from "../../osm-admin/geo-client";

export interface PoolLabel {
  /** Somewhere a visitor plainly goes: the answer should contain these. */
  landmark?: boolean;
  /** Exists rather than invites: picking it is a fault. */
  everyday?: boolean;
  /**
   * One of an interchangeable group. At most `clusterBudget` of them
   * belong in one selection.
   */
  cluster?: string;
  /** Little for a seven-year-old, when the request says one is along. */
  poorForChildren?: boolean;
}

export interface LabelledSpot {
  spot: GeoPoiSearchSpot;
  label: PoolLabel;
}

let nextId = 1;

function spot(
  name: string,
  category: string,
  kind: string,
  opts: {
    wiki?: boolean;
    qid?: boolean;
    label?: PoolLabel;
  } = {},
): LabelledSpot {
  const id = nextId++;
  return {
    spot: {
      osmRef: `way:${id}`,
      type: "way",
      id,
      // A compact town: everything within a couple of kilometres, so
      // distance never decides the answer and the curation is measured
      // on judgement rather than geography.
      lat: 48.0 + id * 0.0015,
      lon: 11.0 + (id % 5) * 0.0015,
      distanceM: 200 + id * 40,
      detourM: null,
      name,
      nameDe: null,
      nameEn: null,
      kind,
      categories: [category],
      wikidataQid: opts.qid === false ? null : `Q${9000 + id}`,
      wikipedia: opts.wiki === false ? null : `de:${name.replace(/ /g, "_")}`,
      openingHours: null,
      cuisine: null,
      wheelchair: null,
      outdoorSeating: null,
      dietVegetarian: null,
      dietVegan: null,
      phone: null,
      website: null,
      facadeAzimuth: null,
    },
    label: opts.label ?? {},
  };
}

/** At most this many of one interchangeable group belong in a selection. */
export const CLUSTER_BUDGET = 2;

export const CURATION_POOL: readonly LabelledSpot[] = [
  // ── Plainly worth going to ───────────────────────────────────────
  spot("Stiftskirche Sankt Kolomann", "worship", "tourism=attraction", {
    label: { landmark: true },
  }),
  spot("Stadtmuseum im Kornhaus", "museum", "tourism=museum", {
    label: { landmark: true },
  }),
  spot("Burgruine Hohenwald", "sight", "tourism=attraction", {
    label: { landmark: true },
  }),
  spot("Aussichtsturm Lindenberg", "viewpoint", "tourism=viewpoint", {
    label: { landmark: true },
  }),
  spot("Botanischer Garten am Mühlbach", "outdoors", "leisure=garden", {
    label: { landmark: true },
  }),
  spot("Tierpark Auwiesen", "zoo", "tourism=zoo", { label: { landmark: true } }),
  spot("Freilichtmuseum Alte Ziegelei", "museum", "tourism=museum", {
    label: { landmark: true },
  }),
  spot("Wochenmarkt am Rathausplatz", "market", "amenity=marketplace", {
    label: { landmark: true },
  }),

  // ── Fine, but not the first eight ────────────────────────────────
  spot("Galerie im Torbogenhaus", "museum", "tourism=gallery"),
  spot("Stadttheater Oberfeld", "theatre", "amenity=theatre", {
    label: { poorForChildren: true },
  }),
  spot("Skulpturenweg Flussaue", "sight", "tourism=artwork"),
  spot("Historischer Friedhof", "sight", "historic=cemetery", {
    label: { poorForChildren: true },
  }),
  spot("Kunstverein Salzstadel", "museum", "tourism=gallery", {
    label: { poorForChildren: true },
  }),
  spot("Alte Seilbahnstation", "sight", "historic=building"),
  spot("Weinberg Sankt Ulrich", "producers", "craft=winery", {
    label: { poorForChildren: true },
  }),
  spot("Stadtpark Rosenau", "outdoors", "leisure=park"),
  spot("Naturbad Weiherfeld", "bath", "leisure=swimming_pool"),
  spot("Uhrenmuseum Kleinberg", "museum", "tourism=museum"),

  // ── Six parish churches, much of a muchness ──────────────────────
  spot("Pfarrkirche Sankt Anna", "worship", "amenity=place_of_worship", {
    label: { cluster: "dorfkirchen" },
  }),
  spot("Pfarrkirche Sankt Georg", "worship", "amenity=place_of_worship", {
    label: { cluster: "dorfkirchen" },
  }),
  spot("Pfarrkirche Sankt Martin", "worship", "amenity=place_of_worship", {
    label: { cluster: "dorfkirchen" },
  }),
  spot("Pfarrkirche Sankt Nikolaus", "worship", "amenity=place_of_worship", {
    label: { cluster: "dorfkirchen" },
  }),
  spot("Pfarrkirche Sankt Vitus", "worship", "amenity=place_of_worship", {
    label: { cluster: "dorfkirchen" },
  }),
  spot("Pfarrkirche Sankt Wolfgang", "worship", "amenity=place_of_worship", {
    label: { cluster: "dorfkirchen" },
  }),

  // ── Exists rather than invites ───────────────────────────────────
  // The first two carry an article on purpose: that is the case where a
  // score built from tags cannot tell a listed building from a place
  // worth an hour.
  spot("Sparkasse am Marktplatz", "essentials", "amenity=bank", {
    label: { everyday: true },
  }),
  spot("Bahnhof Oberfeld", "essentials", "railway=station", {
    label: { everyday: true },
  }),
  spot("Rathaus-Bürgerbüro", "essentials", "amenity=townhall", {
    wiki: false,
    label: { everyday: true },
  }),
  spot("Apotheke im Ärztehaus", "essentials", "amenity=pharmacy", {
    wiki: false,
    qid: false,
    label: { everyday: true },
  }),
  spot("Supermarkt Talstraße", "essentials", "shop=supermarket", {
    wiki: false,
    qid: false,
    label: { everyday: true },
  }),
  spot("Parkhaus Altstadt-Nord", "essentials", "amenity=parking", {
    wiki: false,
    qid: false,
    label: { everyday: true },
  }),

  // ── Food, which a day needs but not eight of ─────────────────────
  spot("Gasthaus Zum Anker", "food", "amenity=restaurant", { wiki: false }),
  spot("Café am Brunnen", "cafe", "amenity=cafe", { wiki: false, qid: false }),
  spot("Biergarten Mühlinsel", "food", "amenity=biergarten", { wiki: false }),
  spot("Bäckerei Sonnenhof", "cafe", "amenity=cafe", { wiki: false, qid: false }),
];

/** What the travellers said, as the curation gets to hear it. */
export const CURATION_REQUEST = {
  town: "Oberfeld",
  days: 2,
  pick: 10,
  sentence:
    "Zwei Tage Oberfeld, mit einem siebenjährigen Kind, wir mögen Geschichte "
    + "und sind gern draußen. Bitte nichts hetzen.",
} as const;
