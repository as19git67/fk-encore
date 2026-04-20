/**
 * Kurated list of visual themes used by the `theme` recap builder.
 *
 * Each theme supplies 1–3 German + English CLIP prompts that are sent to
 * the embedding_service `/search/text` endpoint. The top-K photo IDs per
 * query are unioned, kept if above `threshold`, and — if enough make the
 * cut — grouped into a "Thema"-Rückblick.
 *
 * The theme list is intentionally small and curated. Auto-clustering over
 * all CLIP vectors would surface many low-quality clusters (identical
 * camera bursts, boring document scans, etc.) and would need per-user
 * tuning; named themes give predictable, human-meaningful buckets that
 * the LLM title pass can further personalise.
 */

export interface RecapTheme {
  /** Stable key used in `dedup_key` — never change after release. */
  slug: string;
  /** German fallback title shown when the LLM title pass fails. */
  title: string;
  /** Hints passed to the LLM title pass. */
  keywords: string[];
  /** CLIP prompts — all variants are unioned. Mixed language is fine. */
  queries: string[];
  /** Override the default min-photos gate for rare but meaningful themes. */
  minPhotos?: number;
  /** Override the default CLIP cosine threshold. */
  threshold?: number;
}

export const RECAP_THEMES: RecapTheme[] = [
  {
    slug: "beach",
    title: "Am Meer",
    keywords: ["Strand", "Meer", "Urlaub", "Sommer"],
    queries: [
      "Strand und Meer, Sommerurlaub",
      "beach ocean sand holiday",
    ],
  },
  {
    slug: "mountains",
    title: "Berge",
    keywords: ["Berge", "Wandern", "Alpen", "Natur"],
    queries: [
      "Berge und Wandern, Alpenlandschaft",
      "mountain hiking alpine landscape",
    ],
  },
  {
    slug: "food",
    title: "Essen & Genuss",
    keywords: ["Essen", "Restaurant", "Kulinarik"],
    queries: [
      "Essen auf dem Teller, Restaurant",
      "food plate meal restaurant",
    ],
  },
  {
    slug: "pets",
    title: "Haustiere",
    keywords: ["Haustier", "Hund", "Katze"],
    queries: [
      "Haustier, Hund, Katze",
      "pet dog cat",
    ],
  },
  {
    slug: "sunset",
    title: "Sonnenuntergänge",
    keywords: ["Sonnenuntergang", "Abendhimmel"],
    queries: [
      "Sonnenuntergang am Abendhimmel",
      "sunset golden hour sky",
    ],
    // Sunsets are visually distinctive → raise threshold to avoid
    // landscape false-positives.
    threshold: 0.25,
  },
  {
    slug: "winter",
    title: "Winter & Schnee",
    keywords: ["Winter", "Schnee", "Eis"],
    queries: [
      "Schneelandschaft, Winter",
      "snow winter landscape",
    ],
  },
  {
    slug: "flowers",
    title: "Blumen & Garten",
    keywords: ["Blumen", "Garten", "Frühling"],
    queries: [
      "Blumen und Blüten im Garten",
      "flowers blossoms garden",
    ],
  },
  {
    slug: "celebrations",
    title: "Feste & Feiern",
    keywords: ["Geburtstag", "Feier", "Kuchen"],
    queries: [
      "Geburtstag, Feier, Kuchen mit Kerzen",
      "birthday party cake candles",
    ],
    minPhotos: 8,
  },
];
