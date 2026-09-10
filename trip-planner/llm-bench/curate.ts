/**
 * Asking for a curated selection, in the words both tracks hear (§11.3).
 *
 * One prompt, built once, used by both models — the same rule as the
 * sentence bench: a comparison where each side gets its own prompt
 * measures prompt engineering.
 *
 * What the prompt does **not** do is tell the model what a good answer
 * looks like. No "avoid several similar churches", no "leave out banks".
 * That would be handing over the finding: the whole question of §11.3
 * is whether a model *notices* the six village churches, and a prompt
 * that names them measures obedience instead.
 */

import type { GeoPoiSearchSpot } from "../../osm-admin/geo-client";

export interface CurationRequestText {
  town: string;
  days: number;
  pick: number;
  sentence: string;
}

export function buildCuratePrompt(
  pool: readonly GeoPoiSearchSpot[],
  request: CurationRequestText,
): string {
  const lines = pool.map((spot) => {
    const parts = [
      spot.osmRef,
      spot.name ?? "(ohne Namen)",
      `kategorie=${spot.categories[0] ?? "?"}`,
      `tag=${spot.kind ?? "?"}`,
    ];
    if (spot.wikipedia) parts.push("wikipedia=ja");
    if (spot.wikidataQid) parts.push("wikidata=ja");
    if (spot.distanceM !== null) parts.push(`entfernung=${spot.distanceM}m`);
    return `- ${parts.join(" | ")}`;
  });

  return [
    `Du wählst aus einem Vorrat von ${pool.length} Orten die ${request.pick} aus,`,
    `die auf eine Reise nach ${request.town} gehören.`,
    "",
    "Anfrage der Reisenden:",
    request.sentence,
    "",
    `Aufenthalt: ${request.days} Tage.`,
    "",
    "Vorrat:",
    ...lines,
    "",
    "Antworte ausschließlich mit einem JSON-Objekt, ohne Erklärung, ohne Markdown:",
    '  { "picks": [ { "ref": "way:12", "why": "ein Satz" }, … ] }',
    "",
    "Regeln:",
    `- Genau ${request.pick} Einträge.`,
    "- Nur Referenzen aus dem Vorrat oben. Erfinde keine.",
    '- "why" ist ein kurzer Satz, warum dieser Ort auf diese Reise gehört.',
  ].join("\n");
}

export interface ParsedCuration {
  picks: Array<{ osmRef: string; why?: string }>;
  /** Entries the answer contained that were not usable at all. */
  unusable: number;
}

/**
 * Read the picks out of whatever came back.
 *
 * Tolerant about shape — `picks`, a bare array, `ref` or `osmRef` — and
 * strict about content: an entry without a usable reference is counted
 * rather than guessed at. Being generous here keeps the measurement
 * about curation rather than about JSON habits; being generous about
 * the *reference* would let a track score for an answer nobody could
 * act on.
 */
export function parseCuration(raw: unknown): ParsedCuration {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { picks?: unknown } | null)?.picks)
      ? ((raw as { picks: unknown[] }).picks)
      : [];

  const picks: Array<{ osmRef: string; why?: string }> = [];
  let unusable = 0;
  for (const entry of list) {
    if (typeof entry === "string") {
      picks.push({ osmRef: entry });
      continue;
    }
    const record = entry as Record<string, unknown> | null;
    const ref = record?.ref ?? record?.osmRef ?? record?.osm_ref;
    if (typeof ref !== "string" || ref.trim() === "") {
      unusable += 1;
      continue;
    }
    const why = record?.why ?? record?.grund ?? record?.reason;
    picks.push({
      osmRef: ref.trim(),
      why: typeof why === "string" ? why : undefined,
    });
  }
  return { picks, unusable };
}
