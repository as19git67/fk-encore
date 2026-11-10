/**
 * The local model's order of one stay's places (plan
 * `kandidaten-ranking.md`, stage 3; since reise-planen-und-unterwegs.md
 * stage 7 only the highlights of a stay ask for it).
 *
 * What the measurement of §11.0 found and this builds, and nothing
 * beyond it: given the pool, the interests and the group in the
 * abstract, a model orders the places better than any sum over tags,
 * and says in one sentence why each belongs on this trip.
 *
 * Pure: the prompt, the gate the answer passes, and the arithmetic of
 * "has the list changed enough to ask again". The job that asks lives
 * in `highlights-job.ts`, the model and the stay's description in
 * `highlights-model.ts`.
 *
 * The gate is the point (§10.4). The model may order and explain what
 * the pool holds; it may not add a place, and it may not add a fact.
 * A reference it made up is dropped, a place named twice counts once,
 * and a sentence that names something the input did not say — an
 * hour, a price, a weekday — is replaced by the open-data reason,
 * because a card that says "täglich ab 9 Uhr geöffnet" on the model's
 * word is a promise nobody checked.
 */

/** One pool entry as the model sees it. */
export interface CurationEntry {
  osmRef: string;
  name: string | null;
  /** The planner category ("museum", "viewpoint", …). */
  category: string;
  /** The open-data reasons (prominence, tags), as the card shows them. */
  reasons: readonly string[];
  /** The Wikivoyage line or the Wikipedia lead, where there is one. */
  text: string | null;
  /** Brought in by a person. Still ordered; its score is not touched. */
  manual?: boolean;
}

/** What the trip says about itself, abstractly (§11.5). */
export interface CurationContext {
  /** The stay's name, as the itinerary calls it. */
  town: string | null;
  days: number;
  /** Interest labels the trip searched for; empty is "everything". */
  interests: readonly string[];
  /** "2 Erwachsene, 1 Kind (7)" — never names, never an address. */
  group: string | null;
}

export interface CuratedPick {
  osmRef: string;
  /** The sentence for the card, after the gate; null when there is none. */
  reason: string | null;
}

export interface GateResult {
  picks: CuratedPick[];
  /** References the answer named that are not in the pool. */
  invented: number;
  /** Sentences replaced because they named a fact the input did not hold. */
  replaced: number;
}

/** More than this many entries are cut, best open-data score first. */
export const MAX_CURATION_ENTRIES = 60;
/** Fewer than this and there is nothing to order. */
export const MIN_CURATION_ENTRIES = 3;
/**
 * How many places may come or go before the order is asked again.
 * "More than a handful": one find added from a blog does not make a
 * minute of model time worth it; a re-plan with a wider radius does.
 */
export const CURATION_CHANGE_TOLERANCE = 5;
const TEXT_CHARS = 240;
const REASON_CHARS = 220;

export function buildCurationPrompt(
  entries: readonly CurationEntry[],
  context: CurationContext,
): string {
  const lines = entries.map((entry) => {
    const parts = [
      entry.osmRef,
      entry.name ?? "(ohne Namen)",
      `kategorie=${entry.category}`,
    ];
    if (entry.manual) parts.push("von den Reisenden selbst hinzugefügt");
    if (entry.reasons.length > 0) parts.push(`bekannt: ${entry.reasons.join(", ")}`);
    if (entry.text) parts.push(`text: ${clip(oneLine(entry.text), TEXT_CHARS)}`);
    return `- ${parts.join(" | ")}`;
  });

  const trip = [
    context.town ? `Aufenthalt: ${context.town}, ${context.days} ${context.days === 1 ? "Tag" : "Tage"}.` : `Aufenthalt: ${context.days} ${context.days === 1 ? "Tag" : "Tage"}.`,
    context.group ? `Reisegruppe: ${context.group}.` : null,
    context.interests.length > 0
      ? `Interessen: ${context.interests.join(", ")}.`
      : "Interessen: alles.",
  ].filter((line): line is string => line !== null);

  return [
    `Du ordnest ${entries.length} Orte für eine Reise, den besten zuerst.`,
    "",
    ...trip,
    "",
    "Orte:",
    ...lines,
    "",
    "Antworte ausschließlich mit einem JSON-Objekt, ohne Erklärung, ohne Markdown:",
    '  { "order": [ { "ref": "way:12", "why": "ein Satz" }, … ] }',
    "",
    "Regeln:",
    "- Jeder Ort aus der Liste genau einmal, der lohnendste für diese Gruppe zuerst.",
    "- Nur Referenzen aus der Liste oben. Erfinde keine.",
    '- "why" ist ein kurzer Satz, warum dieser Ort auf diese Reise gehört.',
    '- In "why" nur, was oben steht: keine Öffnungszeiten, keine Preise, keine Zahlen, die oben fehlen.',
  ].join("\n");
}

/**
 * Read the answer and pass it through the gate.
 *
 * Tolerant about shape — `order`, `picks`, a bare array, `ref` or
 * `osmRef`, `why` or `reason` — and strict about content.
 */
export function gateCuration(
  raw: unknown,
  entries: readonly CurationEntry[],
  context: CurationContext,
): GateResult {
  const byRef = new Map(entries.map((entry) => [entry.osmRef, entry]));
  const record = raw as { order?: unknown; picks?: unknown } | null;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(record?.order)
      ? record.order as unknown[]
      : Array.isArray(record?.picks)
        ? record.picks as unknown[]
        : [];

  const seen = new Set<string>();
  const picks: CuratedPick[] = [];
  let invented = 0;
  let replaced = 0;
  for (const item of list) {
    const fields = typeof item === "string" ? { ref: item } : item as Record<string, unknown> | null;
    const ref = fields?.ref ?? fields?.osmRef ?? fields?.osm_ref;
    if (typeof ref !== "string") continue;
    const osmRef = ref.trim();
    const entry = byRef.get(osmRef);
    if (!entry) {
      invented += 1;
      continue;
    }
    if (seen.has(osmRef)) continue;
    seen.add(osmRef);

    const said = fields?.why ?? fields?.reason ?? fields?.grund;
    let reason = typeof said === "string" ? cleanReason(said) : null;
    if (reason !== null && namesUnknownFact(reason, sourceOf(entry, context))) {
      reason = entry.reasons[0] ?? null;
      replaced += 1;
    }
    picks.push({ osmRef, reason });
  }
  return { picks, invented, replaced };
}

/**
 * Does the sentence say something the input did not?
 *
 * Two checks, both cheap and both about the kind of claim a card must
 * not make on a model's word: every number in the sentence has to be
 * in the input, and the words of opening hours and prices — "Uhr",
 * "geöffnet", "Eintritt", a weekday — only pass where the input used
 * them too. A sentence about why a castle suits a seven-year-old is
 * fine; one that says when it opens is not this gate's to believe.
 */
export function namesUnknownFact(sentence: string, source: string): boolean {
  const haystack = source.toLowerCase();
  const digits = haystack.replace(/[.\s]/g, "");
  for (const match of sentence.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const bare = match[0].replace(/[.,]/g, "");
    if (!digits.includes(bare)) return true;
  }
  for (const match of sentence.toLowerCase().matchAll(FACT_WORDS)) {
    if (!haystack.includes(match[0])) return true;
  }
  return false;
}

const FACT_WORDS = new RegExp(
  "\\b(uhr|geöffnet|geschlossen|öffnungszeit\\w*|eintritt\\w*|kostenlos|gratis|euro|tickets?|"
  + "montags?|dienstags?|mittwochs?|donnerstags?|freitags?|samstags?|sonntags?|täglich|"
  + "feiertags?|ruhetag)\\b|€",
  "g",
);

/** Everything the model was told about one entry, as the gate reads it. */
function sourceOf(entry: CurationEntry, context: CurationContext): string {
  return [
    entry.name ?? "",
    entry.category,
    ...entry.reasons,
    entry.text ?? "",
    context.town ?? "",
    context.group ?? "",
    ...context.interests,
    String(context.days),
  ].join(" ");
}

function cleanReason(value: string): string | null {
  const text = oneLine(value).replace(/^["„“'»«]+|["„“'»«]+$/g, "").trim();
  if (text === "") return null;
  return clip(text, REASON_CHARS);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, chars: number): string {
  if (value.length <= chars) return value;
  const cut = value.slice(0, chars);
  const space = cut.lastIndexOf(" ");
  return `${(space > chars / 2 ? cut.slice(0, space) : cut).trimEnd()} …`;
}

/** What the pool and the interests looked like when the order was asked. */
export interface CurationSignature {
  refs: string[];
  interests: string[];
}

export function signatureOf(refs: Iterable<string>, interests: Iterable<string>): CurationSignature {
  return {
    refs: [...new Set(refs)].sort(),
    interests: [...new Set(interests)].sort(),
  };
}

/**
 * Should the order be asked (again)?
 *
 * Asked when there is none, when the interests changed, or when more
 * than `CURATION_CHANGE_TOLERANCE` places came or went. Never for a
 * pool too small to have an order.
 */
export function curationDue(
  stored: CurationSignature | null,
  current: CurationSignature,
): boolean {
  if (current.refs.length < MIN_CURATION_ENTRIES) return false;
  if (!stored) return true;
  if (stored.interests.join("\n") !== current.interests.join("\n")) return true;
  const before = new Set(stored.refs);
  const now = new Set(current.refs);
  let changed = 0;
  for (const ref of now) if (!before.has(ref)) changed += 1;
  for (const ref of before) if (!now.has(ref)) changed += 1;
  return changed > CURATION_CHANGE_TOLERANCE;
}

/**
 * The group in the abstract (§11.5): how many adults, and the children
 * with their age on the trip's first day. Nobody's name goes along.
 */
export function groupLine(
  birthDates: ReadonlyArray<string | null>,
  onDate: string | null,
): string | null {
  if (birthDates.length === 0) return null;
  const reference = onDate ?? new Date().toISOString().slice(0, 10);
  let adults = 0;
  const children: number[] = [];
  for (const birth of birthDates) {
    const age = birth ? ageOn(birth, reference) : null;
    if (age !== null && age < 18) children.push(age);
    else adults += 1;
  }
  const parts: string[] = [];
  if (adults > 0) parts.push(`${adults} ${adults === 1 ? "Erwachsener" : "Erwachsene"}`);
  if (children.length > 0) {
    const ages = children.sort((a, b) => a - b).join(", ");
    parts.push(`${children.length} ${children.length === 1 ? "Kind" : "Kinder"} (${ages})`);
  }
  return parts.join(", ");
}

function ageOn(birth: string, on: string): number | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(birth);
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(on);
  if (!b || !d) return null;
  let age = Number(d[1]) - Number(b[1]);
  if (Number(d[2]) < Number(b[2]) || (d[2] === b[2] && Number(d[3]) < Number(b[3]))) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}
