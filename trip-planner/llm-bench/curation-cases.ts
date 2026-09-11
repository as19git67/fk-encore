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

/**
 * What a spot serves, for measuring whether the request was heard.
 *
 * Deliberately few and coarse: a theme is only useful here if two
 * readers would label a spot the same way. "geschichte" is arguable
 * about a sculpture trail and obvious about a castle ruin, so the
 * arguable ones simply carry both or neither.
 */
export type Theme = "geschichte" | "draussen" | "kinder" | "kunst" | "essen" | "ruhe";

export interface PoolLabel {
  /** What this spot serves. */
  themes?: readonly Theme[];
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
    label: { landmark: true, themes: ["geschichte", "ruhe"] },
  }),
  spot("Stadtmuseum im Kornhaus", "museum", "tourism=museum", {
    label: { landmark: true, themes: ["geschichte"] },
  }),
  spot("Burgruine Hohenwald", "sight", "tourism=attraction", {
    label: { landmark: true, themes: ["geschichte", "draussen", "kinder"] },
  }),
  spot("Aussichtsturm Lindenberg", "viewpoint", "tourism=viewpoint", {
    label: { landmark: true, themes: ["draussen"] },
  }),
  spot("Botanischer Garten am Mühlbach", "outdoors", "leisure=garden", {
    label: { landmark: true, themes: ["draussen", "ruhe"] },
  }),
  spot("Tierpark Auwiesen", "zoo", "tourism=zoo", {
    label: { landmark: true, themes: ["kinder", "draussen"] },
  }),
  spot("Freilichtmuseum Alte Ziegelei", "museum", "tourism=museum", {
    label: { landmark: true, themes: ["geschichte", "draussen", "kinder"] },
  }),
  spot("Wochenmarkt am Rathausplatz", "market", "amenity=marketplace", {
    label: { landmark: true, themes: ["essen", "draussen"] },
  }),

  // ── Fine, but not the first eight ────────────────────────────────
  spot("Galerie im Torbogenhaus", "museum", "tourism=gallery", {
    label: { themes: ["kunst"] },
  }),
  spot("Stadttheater Oberfeld", "theatre", "amenity=theatre", {
    label: { poorForChildren: true, themes: ["kunst"] },
  }),
  spot("Skulpturenweg Flussaue", "sight", "tourism=artwork", {
    label: { themes: ["kunst", "draussen"] },
  }),
  spot("Historischer Friedhof", "sight", "historic=cemetery", {
    label: { poorForChildren: true, themes: ["geschichte", "ruhe"] },
  }),
  spot("Kunstverein Salzstadel", "museum", "tourism=gallery", {
    label: { poorForChildren: true, themes: ["kunst"] },
  }),
  spot("Alte Seilbahnstation", "sight", "historic=building", {
    label: { themes: ["geschichte"] },
  }),
  spot("Weinberg Sankt Ulrich", "producers", "craft=winery", {
    label: { poorForChildren: true, themes: ["essen", "draussen"] },
  }),
  spot("Stadtpark Rosenau", "outdoors", "leisure=park", {
    label: { themes: ["draussen", "kinder", "ruhe"] },
  }),
  spot("Naturbad Weiherfeld", "bath", "leisure=swimming_pool", {
    label: { themes: ["draussen", "kinder"] },
  }),
  spot("Uhrenmuseum Kleinberg", "museum", "tourism=museum", {
    label: { themes: ["geschichte"] },
  }),

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
  spot("Gasthaus Zum Anker", "food", "amenity=restaurant", {
    wiki: false,
    label: { themes: ["essen"] },
  }),
  spot("Café am Brunnen", "cafe", "amenity=cafe", {
    wiki: false, qid: false,
    label: { themes: ["essen", "ruhe"] },
  }),
  spot("Biergarten Mühlinsel", "food", "amenity=biergarten", {
    wiki: false,
    label: { themes: ["essen", "draussen"] },
  }),
  spot("Bäckerei Sonnenhof", "cafe", "amenity=cafe", {
    wiki: false, qid: false,
    label: { themes: ["essen"] },
  }),
];

/**
 * What the travellers said, and what that asks for.
 *
 * Three requests over **one** pool rather than three pools, and that is
 * the experiment rather than a shortcut: the axis where the two models
 * differed in the first run was not which places they know but whether
 * they *heard the sentence*. Holding the pool still and changing only
 * the request puts exactly that under the light — the same 34 places
 * have three different right answers.
 *
 * `wants` names the themes the sentence asks for. A wanted theme that
 * gets nothing at all is the one taste-free fault in this area: not
 * "too little history" (an argument), but "the sentence said history
 * and the selection has none" (an oversight).
 */
export interface CurationCase {
  id: string;
  town: string;
  days: number;
  pick: number;
  sentence: string;
  wants: readonly Theme[];
  /** Whether a child is along — what makes `poorForChildren` count. */
  withChildren: boolean;
  /**
   * The interest ids an interpreter would produce from this sentence
   * (`interests.ts`).
   *
   * The weighted sum is not deaf: a matched interest is worth +2. Not
   * giving it these would measure a straw man — the incumbent gets the
   * same reading of the sentence that the models get to make for
   * themselves.
   */
  interests: readonly string[];
  /** Why this case exists, for the report. */
  note: string;
}

export const CURATION_CASES: readonly CurationCase[] = [
  {
    id: "geschichte-kind",
    town: "Oberfeld",
    days: 2,
    pick: 10,
    sentence:
      "Zwei Tage Oberfeld, mit einem siebenjährigen Kind, wir mögen Geschichte "
      + "und sind gern draußen. Bitte nichts hetzen.",
    wants: ["geschichte", "draussen", "kinder"],
    withChildren: true,
    interests: ["castles", "ruins", "museum", "monuments", "nature", "landscape", "views"],
    note: "Drei Wünsche gleichzeitig — der Fall, an dem sich die erste Messung schied.",
  },
  {
    id: "kunst-erwachsene",
    town: "Oberfeld",
    days: 2,
    pick: 8,
    sentence:
      "Zwei Tage Oberfeld zu zweit, ohne Kinder. Uns interessiert vor allem "
      + "Kunst, und abends gern gut essen.",
    wants: ["kunst", "essen"],
    withChildren: false,
    interests: ["art", "museum", "stage"],
    note: "Dasselbe Pool, anderer Satz: Was vorher falsch war (Theater, Weinberg), ist jetzt richtig.",
  },
  {
    id: "ruhe-kurz",
    town: "Oberfeld",
    days: 1,
    pick: 5,
    sentence:
      "Wir haben nur einen Tag in Oberfeld und wollen es ruhig angehen — "
      + "viel draußen, nichts Anstrengendes.",
    wants: ["ruhe", "draussen"],
    withChildren: false,
    interests: ["nature", "landscape", "views"],
    note: "Fünf statt zehn: Wenig zu wählen zwingt zu einer Entscheidung.",
  },
];

/** The first case, for callers that want just one. */
export const CURATION_REQUEST = CURATION_CASES[0];
