/**
 * Pulling place names out of an article (§9.3, stage 3).
 *
 * The model gets exactly one job and a strict schema: a list of *name*,
 * optional *place hint*, optional *category* and a **verbatim quote**
 * from the page. The quote is the trick — it can be checked
 * mechanically against the source, and an entry whose quote is not
 * literally there is dropped. A recommendation the model invented does
 * not survive that check.
 *
 * Extracting is also the friendlier task than recommending: the answer
 * is in the text it was handed, which is why a small local model is
 * good enough for it.
 *
 * Validation lives here rather than at the call site, and apart from
 * the HTTP call, so the whole of it can be tested without a model in
 * the loop — the same split `constraints.ts` makes for the sentence
 * interpreter.
 */

import { quoteAppearsIn } from "./article";

/** More than this from one page is a listing being scraped, not research. */
export const MAX_EXTRACTED_PLACES = 25;
/** A name longer than this is a sentence the model mislabelled. */
export const MAX_NAME_CHARS = 120;
export const MAX_HINT_CHARS = 120;
/** Enough of the page to see why, short enough to show in a list. */
export const MAX_QUOTE_CHARS = 400;

export interface ExtractedPlace {
  name: string;
  /** "in der Altstadt", "am Hafen" — carried along, never acted on. */
  placeHint: string | null;
  /**
   * What the article called it ("Café", "Museum"). A free word, not a
   * category id: mapping it into the vocabulary is geo's job once the
   * name resolves to a POI, and a made-up id here would look like data.
   */
  kindHint: string | null;
  /** The words in the page that put it on the list. */
  quote: string;
}

export interface ExtractionResult {
  places: ExtractedPlace[];
  /**
   * What the model proposed and this refused, in plain words. Shown
   * rather than swallowed: an extraction that quietly halves is worse
   * than one that says what it dropped.
   */
  rejected: string[];
}

/**
 * Validate a model's answer against the page it was given.
 *
 * Nothing is trusted: not the shape, not the types, not the names, and
 * above all not the quotes. `sourceText` is the text the model was
 * shown, and every entry is checked against it.
 */
export function parseExtractedPlaces(raw: unknown, sourceText: string): ExtractionResult {
  const rejected: string[] = [];
  const items = itemsOf(raw);
  if (items === null) {
    return { places: [], rejected: ["die Antwort des Modells war keine Liste von Orten"] };
  }

  const places: ExtractedPlace[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (typeof item !== "object" || item === null) {
      rejected.push("ein Eintrag war kein Objekt");
      continue;
    }
    const entry = item as Record<string, unknown>;

    const name = trimmedString(entry.name, MAX_NAME_CHARS);
    if (!name) {
      rejected.push("ein Eintrag ohne brauchbaren Namen");
      continue;
    }

    const quote = trimmedString(entry.quote, MAX_QUOTE_CHARS);
    if (!quote) {
      rejected.push(`„${name}“ kam ohne Zitat`);
      continue;
    }
    if (!quoteAppearsIn(quote, sourceText)) {
      // The check the whole design turns on. A name the page never
      // mentioned cannot bring a quote that is in the page.
      rejected.push(`„${name}“ — das angegebene Zitat steht so nicht in der Seite`);
      continue;
    }

    // Two mentions of one café in a long article are one candidate.
    const key = name.toLocaleLowerCase("de");
    if (seen.has(key)) continue;
    seen.add(key);

    places.push({
      name,
      placeHint: trimmedString(entry.placeHint ?? entry.place, MAX_HINT_CHARS),
      kindHint: trimmedString(entry.category ?? entry.kind, MAX_HINT_CHARS),
      quote,
    });

    if (places.length >= MAX_EXTRACTED_PLACES) {
      const remaining = items.length - index - 1;
      if (remaining > 0) {
        rejected.push(`${remaining} weitere Einträge — mehr als ${MAX_EXTRACTED_PLACES} pro Seite`);
      }
      break;
    }
  }

  return { places, rejected };
}

/**
 * The list, wherever the model chose to put it.
 *
 * A bare array and `{ places: [...] }` are both common answers to the
 * same prompt, and refusing one of them would throw away a perfectly
 * good extraction over a wrapper object.
 */
function itemsOf(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && raw !== null) {
    for (const key of ["places", "orte", "results", "items"]) {
      const value = (raw as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

function trimmedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars).trimEnd() : trimmed;
}

/**
 * The prompt.
 *
 * Exported so a test can hold it to what the parser expects — a field
 * renamed here and not there would silently extract nothing, and the
 * symptom ("the model found no places on this page") looks exactly like
 * a page with no places on it.
 */
export function buildExtractPrompt(articleText: string): string {
  return [
    "Du liest einen Reisetext und ziehst die darin genannten Orte heraus.",
    "Antworte ausschließlich mit einem JSON-Array, ohne Erklärung, ohne Markdown.",
    "",
    "Jeder Eintrag hat diese Felder:",
    '  "name":      string, der Name des Ortes, genau wie im Text',
    '  "placeHint": string, optional: die Ortsangabe aus dem Text („in der Altstadt“)',
    '  "category":  string, optional: was es ist („Café“, „Museum“, „Aussichtspunkt“)',
    '  "quote":     string, ein WÖRTLICHES Zitat aus dem Text, in dem der Ort vorkommt',
    "",
    "Regeln:",
    "- Das Zitat muss buchstäblich im Text stehen. Es wird geprüft; ein erfundenes",
    "  Zitat lässt den ganzen Eintrag wegfallen.",
    "- Nimm nur Orte, die man besuchen kann: Lokale, Museen, Plätze, Aussichtspunkte,",
    "  Parks, Geschäfte. Keine Länder, keine Regionen, keine ganzen Städte.",
    "- Erfinde nichts. Steht ein Ort nicht im Text, gehört er nicht in die Liste.",
    "- Lass ein Feld weg, wenn der Text es nicht hergibt. Ein fehlendes Feld ist",
    "  besser als ein geratenes.",
    "- Nenne jeden Ort nur einmal, auch wenn er mehrfach vorkommt.",
    "",
    "Text:",
    articleText,
  ].join("\n");
}
