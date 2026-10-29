/**
 * What the local model is asked about a photo book, and how its answers are
 * read (documentation/plans/fotobuch.md, stages 2 and 3). Pure functions: the
 * job that gathers the facts and calls the llm-service is `photo-book-ai.ts`.
 *
 * The model writes captions and chapter titles from facts the app hands it —
 * date, place, the landmark the photo was matched to and its Wikipedia text,
 * the names of people the owner has named — and from the picture. It never
 * guesses a name or a place: what is not in the facts stays out of the text.
 */

import type { LayoutChoice, PhotoBookFormat } from "./photo-book-layout";
import { PHOTO_BOOK_FORMATS, cellRect, cropLoss, photoAspect } from "./photo-book-layout";

export interface LlmPrompt {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
}

/** A caption stays on one or two lines under a photo. */
export const MAX_CAPTION_LENGTH = 100;
/** A chapter title fits one line on the opener. */
export const MAX_CHAPTER_TITLE_LENGTH = 60;
/** Wikipedia's lead is cut to this many characters before it goes into a prompt. */
export const MAX_ARTICLE_CHARS = 700;

// ── captions ────────────────────────────────────────────────────────────

export interface PoiFacts {
  name: string;
  /** Wikidata's one-line description. */
  description: string | null;
  /** The start of the Wikipedia article. */
  extract: string | null;
}

export interface CaptionContext {
  /** "Montag, 3. Juni 2024, 14:20" or null. */
  when: string | null;
  /** "Altstadt, Musterstadt, Beispielland" or null. */
  place: string | null;
  poi: PoiFacts | null;
  /** Names the owner gave the people in the photo. */
  people: string[];
  /** The photo's own description or keywords from its file. */
  description: string | null;
  keywords: string[];
  /** What the text recognition read on the photo (a sign, a board), or null. */
  signText?: string | null;
  /** The spot of one of the owner's trips the photo was taken at, and the trip's title. */
  tripSpot?: { spot: string; trip: string | null } | null;
  /** Captions the other photos of the same page already have; the new one must say something else. */
  onPage?: string[];
}

export const CAPTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { caption: { type: "string" } },
  required: ["caption"],
};

const CAPTION_SYSTEM =
  "Du schreibst Bildunterschriften für ein privates Fotobuch auf Deutsch. " +
  "Eine Bildunterschrift sagt, was man dem Bild nicht ansieht: wo es ist (Ort, Viertel, Straße), wie die Sehenswürdigkeit heißt, " +
  "wer darauf ist, was auf einem Schild steht, was die Beschreibung des Fotos sagt oder eine kurze Tatsache aus dem Wikipedia-Text. " +
  "Was man ohnehin sieht, beschreibst du nicht: kein \"Blick auf\", kein \"Detail\", keine Decke, kein Gewölbe, keine Gasse, " +
  "keine Adjektive über das Aussehen wie prachtvoll, kunstvoll, malerisch oder bemalt. " +
  "Kurz: eine Wortgruppe, höchstens zehn Wörter, oft nur ein Name. " +
  "Das Bild hilft dir nur zu entscheiden, welche Fakten passen. " +
  "Du erfindest keine Namen, Orte, Daten oder Ereignisse. Personen nennst du nur mit den angegebenen Namen. " +
  "Keine Anführungszeichen, keine Emojis, keine Hashtags, keine Bewertung des Fotos. " +
  "Gibt es nichts zu sagen, was man nicht sieht, bleibt die Bildunterschrift leer.";

/**
 * Whether there is something concrete to say: a place, a landmark, people the
 * owner named, the photo's own description, text on a sign in the photo or
 * the spot of a trip it was taken at. The date and keywords alone are
 * not enough — a caption from them would only describe the picture.
 */
export function hasConcreteFacts(ctx: CaptionContext): boolean {
  return !!(ctx.place || ctx.poi || ctx.people.length || ctx.description || ctx.signText || ctx.tripSpot);
}

/** Whether `text` holds `term` starting at a word (so "Musterstadts" names Musterstadt). */
function namesTerm(text: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < 3) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}`, "u").test(text);
}

/**
 * Whether a caption names one of the concrete facts. A caption that names
 * none of them describes the picture in general ("Ein alter Keller") and is
 * not kept. A place counts by any of its parts, a landmark by its name or the
 * last word of it (German names end in the noun: "am Alten Turm"), a person
 * by the first name, the photo's description and the text on a sign by any
 * longer word of them, a trip's spot like a landmark.
 */
export function captionNamesAFact(caption: string, ctx: CaptionContext): boolean {
  const text = caption.toLowerCase();
  const terms: string[] = [];
  if (ctx.place) terms.push(...ctx.place.split(","));
  if (ctx.poi) {
    const words = ctx.poi.name.trim().split(/\s+/);
    terms.push(ctx.poi.name, words[words.length - 1] ?? "");
  }
  for (const name of ctx.people) terms.push(name.trim().split(/\s+/)[0] ?? "");
  if (ctx.description) terms.push(...ctx.description.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5));
  if (ctx.signText) terms.push(...ctx.signText.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5));
  if (ctx.tripSpot) {
    const words = ctx.tripSpot.spot.trim().split(/\s+/);
    terms.push(ctx.tripSpot.spot, words[words.length - 1] ?? "");
  }
  return terms.some((t) => namesTerm(text, t));
}

/** Short words that say nothing about the picture: articles, prepositions, conjunctions. */
const FUNCTION_WORDS = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "eines", "einem", "einen",
  "und", "oder", "mit", "von", "vom", "zum", "zur", "beim", "aus", "auf", "über", "unter", "vor",
  "hinter", "neben", "zwischen", "nach", "durch", "für", "gegen", "ohne", "bei", "seit", "bis",
  "ist", "sind", "war", "waren", "wird", "wurde", "wurden", "hat", "haben", "sich", "auch", "dort",
  "hier", "sein", "seine", "seiner", "seinem", "seinen", "ihre", "ihrer", "ihrem", "ihren", "diese",
  "dieser", "dieses", "diesem", "diesen", "heute", "noch", "schon", "steht", "liegt",
]);

/** Whether `word` is (an inflection of) one of `facts`: the same start, as German endings vary. */
function isFactWord(word: string, facts: Set<string>): boolean {
  if (facts.has(word)) return true;
  for (const f of facts) {
    const n = Math.min(word.length, f.length);
    if (n >= 4 && word.length - n <= 3 && f.length - n <= 3 && word.slice(0, n - 1) === f.slice(0, n - 1)) return true;
  }
  return false;
}

/**
 * How many words of a caption only describe what the picture shows: words
 * that are neither a function word nor a word of the facts (place, landmark
 * and its Wikipedia text, people, the photo's description, sign text, trip
 * spot). "Das kunstvoll bemalte Gewölbe in Musterstadt" names the place, but
 * three words of it describe the picture.
 */
export function descriptiveWords(caption: string, ctx: CaptionContext): string[] {
  const factText = [
    ctx.place, ctx.poi?.name, ctx.poi?.description, ctx.poi?.extract, ctx.description, ctx.signText,
    ctx.tripSpot?.spot, ctx.tripSpot?.trip, ...ctx.people,
  ].filter(Boolean).join(" ").toLowerCase();
  const facts = new Set(factText.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
  return caption.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) =>
    w.length >= 4 && !/^\p{N}+$/u.test(w) && !FUNCTION_WORDS.has(w) && !isFactWord(w, facts));
}

/** At most this many words of a caption may say what one sees anyway ("Gassen in Musterstadt"). */
export const MAX_DESCRIPTIVE_WORDS = 1;

/**
 * Whether a caption is worth printing: it names a concrete fact and says
 * little more than that. One that mostly describes what the picture shows
 * ("Blick auf die prachtvolle Decke in Musterstadt") is not kept, even with
 * a place in it: the reader sees the ceiling, the place is what they learn.
 */
export function captionWorthKeeping(caption: string, ctx: CaptionContext): boolean {
  return captionNamesAFact(caption, ctx) && descriptiveWords(caption, ctx).length <= MAX_DESCRIPTIVE_WORDS;
}

/** Lines for the facts the app knows; empty when it knows nothing. */
export function captionFacts(ctx: CaptionContext): string[] {
  const lines: string[] = [];
  if (ctx.when) lines.push(`Aufgenommen: ${ctx.when}`);
  if (ctx.place) lines.push(`Ort: ${ctx.place}`);
  if (ctx.poi) {
    lines.push(`Sehenswürdigkeit im Bild: ${ctx.poi.name}${ctx.poi.description ? ` (${ctx.poi.description})` : ""}`);
    if (ctx.poi.extract) lines.push(`Aus Wikipedia: ${ctx.poi.extract}`);
  }
  if (ctx.people.length) lines.push(`Personen im Bild: ${ctx.people.join(", ")}`);
  if (ctx.description) lines.push(`Beschreibung aus der Datei: ${ctx.description}`);
  if (ctx.tripSpot) lines.push(`Spot der Reise${ctx.tripSpot.trip ? ` „${ctx.tripSpot.trip}“` : ""}: ${ctx.tripSpot.spot}`);
  if (ctx.signText) lines.push(`Text auf einem Schild oder einer Tafel im Bild: ${ctx.signText}`);
  if (ctx.keywords.length) lines.push(`Stichwörter: ${ctx.keywords.join(", ")}`);
  return lines;
}

/** The caption prompt; `withImage` false when the model cannot look at the picture. */
export function buildCaptionPrompt(ctx: CaptionContext, withImage: boolean): LlmPrompt {
  const facts = captionFacts(ctx);
  const prompt = [
    withImage ? "Schreibe eine Bildunterschrift für dieses Foto." : "Schreibe eine Bildunterschrift für ein Foto, das du nicht sehen kannst, nur aus den Fakten.",
    facts.length ? "Fakten:" : "Es gibt keine weiteren Fakten.",
    ...facts.map((l) => `- ${l}`),
    ctx.poi
      ? "Wenn die Sehenswürdigkeit im Bild zu sehen ist, nenne sie und, wenn es passt, eine kurze Tatsache aus dem Wikipedia-Text."
      : "",
    ctx.onPage?.length
      ? `Auf derselben Seite stehen schon diese Bildunterschriften: ${ctx.onPage.map((c) => `„${c}“`).join(", ")}. Wiederhole sie nicht; sag etwas anderes oder nichts.`
      : "",
    "Nenne mindestens einen der Fakten (Ort, Sehenswürdigkeit, Spot der Reise, Personen, Beschreibung oder Text im Bild) beim Namen, und sonst fast nichts. " +
      "Nicht: „Das kunstvoll bemalte Gewölbe in Musterstadt“, „Blick auf die prachtvolle Decke in Musterstadt“. " +
      "Sondern: „Dom von Musterstadt“, „Altstadt, Musterstadt“ oder nur „Musterstadt“. " +
      'Gibt es nichts zu sagen, was man dem Bild nicht ansieht, antworte mit {"caption": ""}.',
    "Das Datum gehört nicht in die Bildunterschrift; es steht schon am Kapitelanfang.",
    'Antworte als JSON-Objekt {"caption": "…"}.',
  ]
    .filter(Boolean)
    .join("\n");
  return { system: CAPTION_SYSTEM, prompt, schema: CAPTION_SCHEMA };
}

/** Trim, collapse spaces, drop quotes the model put around it, bound the length at a word. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  let text = value.replace(/\s+/g, " ").trim();
  text = text.replace(/\s*#\S+/g, "").trim();
  text = text.replace(/^["'„“”‚‘’«»]+|["'„“”‚‘’«»]+$/g, "").trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, "")}…`;
}

export function parseCaption(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  return cleanText((raw as Record<string, unknown>).caption, MAX_CAPTION_LENGTH);
}

/** The lead of an article, cut at a sentence end where one is near enough. */
export function articleExtract(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= MAX_ARTICLE_CHARS) return t;
  const cut = t.slice(0, MAX_ARTICLE_CHARS);
  const end = cut.lastIndexOf(". ");
  return end > MAX_ARTICLE_CHARS * 0.5 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

// ── chapter titles ──────────────────────────────────────────────────────

export interface ChapterContext {
  /** The title the date rule gave it, e.g. "Tag 2 · Musterstadt". */
  ruleTitle: string;
  /** The date line under the title, e.g. "Montag, 3. Juni 2024". */
  dates: string | null;
  /** Places of its photos, most frequent first. */
  places: string[];
  /** Landmarks matched in its photos. */
  pois: string[];
  people: string[];
  /** Captions of its photos, in order (at most a dozen). */
  captions: string[];
}

export const CHAPTER_TITLE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
};

const CHAPTER_SYSTEM =
  "Du schlägst Kapitelüberschriften für ein privates Fotobuch auf Deutsch vor. " +
  "Eine Überschrift ist kurz (zwei bis sechs Wörter), anschaulich und trifft, was das Kapitel zeigt. " +
  "Du nutzt nur die Fakten, die du bekommst, und erfindest keine Namen, Orte oder Ereignisse. " +
  "Kein Datum in der Überschrift, es steht schon darunter. Keine Anführungszeichen, keine Emojis.";

export function buildChapterTitlePrompt(ctx: ChapterContext): LlmPrompt {
  const lines = [
    "Schlage eine Überschrift für dieses Kapitel vor.",
    `Bisheriger Titel: ${ctx.ruleTitle}`,
    ctx.dates ? `Zeitraum (steht unter der Überschrift): ${ctx.dates}` : "",
    ctx.places.length ? `Orte: ${ctx.places.join(", ")}` : "",
    ctx.pois.length ? `Sehenswürdigkeiten: ${ctx.pois.join(", ")}` : "",
    ctx.people.length ? `Personen: ${ctx.people.join(", ")}` : "",
    ctx.captions.length ? "Bildunterschriften des Kapitels:" : "",
    ...ctx.captions.map((c) => `- ${c}`),
    'Antworte als JSON-Objekt {"title": "…"}.',
  ];
  return { system: CHAPTER_SYSTEM, prompt: lines.filter(Boolean).join("\n"), schema: CHAPTER_TITLE_SCHEMA };
}

/** A date in the title repeats the line under it ("3. Juni", "2024", "03.06."). */
const DATE_IN_TITLE = /\b\d{1,2}\.\s?(?:\d{1,2}\.|Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)|\b(?:19|20)\d{2}\b/i;

export function parseChapterTitle(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const title = cleanText((raw as Record<string, unknown>).title, MAX_CHAPTER_TITLE_LENGTH);
  if (!title) return null;
  const clean = title.replace(/[.!]+$/, "").trim();
  if (!clean || DATE_IN_TITLE.test(clean)) return null;
  return clean;
}

// ── layouts (stage 3) ───────────────────────────────────────────────────

export interface LayoutPhotoFacts {
  id: number;
  width: number | null;
  height: number | null;
  /** 0..100 */
  score: number;
  /** Recognisable faces on it. */
  faces: number;
  caption: string | null;
}

/** How many candidates the model chooses from. */
export const LAYOUT_CANDIDATES = 4;
/** A pick may crop this much more than the rule's own before it is turned down. */
export const LAYOUT_MAX_EXTRA_COST = 0.1;

export const LAYOUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { choice: { type: "integer" }, reason: { type: "string" } },
  required: ["choice", "reason"],
};

function orientation(p: Pick<LayoutPhotoFacts, "width" | "height">): string {
  const a = photoAspect(p);
  if (a > 1.15) return "Querformat";
  if (a < 0.87) return "Hochformat";
  return "quadratisch";
}

function cellWords(format: PhotoBookFormat, choice: LayoutChoice, i: number): string {
  const c = choice.layout.cells[i];
  const r = cellRect(format, choice.layout, c);
  const share = Math.round(c.w * c.h * 100);
  const shape = r.w / r.h > 1.15 ? "quer" : r.w / r.h < 0.87 ? "hoch" : "quadratisch";
  return `${share} % der Seite, ${shape}`;
}

/**
 * The model gets the photos with what is known about them and the rule's best
 * candidates, each with the photo in each cell and how much it crops; it
 * answers with the number of one. It sees no pixels: orientation, faces,
 * scores and captions are what a layout decision rests on.
 */
export function buildLayoutPrompt(format: PhotoBookFormat, photos: LayoutPhotoFacts[], candidates: LayoutChoice[]): LlmPrompt {
  const f = PHOTO_BOOK_FORMATS[format];
  const byId = new Map(photos.map((p) => [p.id, p]));
  const label = new Map(photos.map((p, i) => [p.id, String.fromCharCode(65 + i)]));
  const photoLines = photos.map((p) => {
    const parts = [orientation(p), `Bewertung ${Math.round(p.score)} von 100`];
    if (p.faces) parts.push(p.faces === 1 ? "ein Gesicht" : `${p.faces} Gesichter`);
    if (p.caption) parts.push(`Bildunterschrift: ${p.caption}`);
    return `- Foto ${label.get(p.id)}: ${parts.join(", ")}`;
  });
  const candidateLines = candidates.map((c, n) => {
    const cells = c.photos.map((p, i) => {
      const r = cellRect(format, c.layout, c.layout.cells[i]);
      const loss = Math.round(cropLoss(photoAspect(byId.get(p.id) ?? p), r.w / r.h) * 100);
      return `Foto ${label.get(p.id)} in Feld ${i + 1} (${cellWords(format, c, i)}, ${loss} % beschnitten)`;
    });
    return `${n + 1}. ${c.layout.name}: ${cells.join("; ")}`;
  });
  const system =
    "Du gestaltest Seiten eines Fotobuchs. Du wählst für eine Seite die Aufteilung, die die Fotos am besten zur Geltung bringt: " +
    "das stärkste Foto groß, Gesichter nicht angeschnitten, wenig Beschnitt, eine ruhige Seite. Du antwortest nur mit JSON.";
  const prompt = [
    `Seite ${f.name}, ${photos.length} Fotos:`,
    ...photoLines,
    "Mögliche Aufteilungen:",
    ...candidateLines,
    'Wähle eine. Antworte als JSON-Objekt {"choice": <Nummer>, "reason": "<ein kurzer Satz>"}.',
  ].join("\n");
  return { system, prompt, schema: LAYOUT_SCHEMA };
}

export interface LayoutPick {
  index: number;
  reason: string | null;
}

export function parseLayoutPick(raw: unknown, count: number): LayoutPick | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = typeof r.choice === "number" ? r.choice : typeof r.choice === "string" ? Number.parseInt(r.choice, 10) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > count) return null;
  return { index: n - 1, reason: cleanText(r.reason, 200) };
}
