/**
 * The article behind a spot, inside the app (§25, stage C).
 *
 * "Artikel lesen" opened Safari, and where the article was Italian the
 * footer said so and left the reading to iOS. What a place is and why
 * it matters is the one thing the map does not hold, and it is what
 * somebody deciding between two churches reads before voting (§3.8).
 * So the article comes into the app, with its pictures the way a
 * route's come (§4.7):
 *
 *   1. **German where German exists.** The link OpenStreetMap gave is
 *      the local article; Wikipedia's language links say whether the
 *      same place has a German one, and that is the one shown.
 *   2. **Otherwise translated.** The local text goes to the llm-service
 *      section by section. That takes minutes on a local model, so the
 *      first answer is the original with `translation: "pending"`, the
 *      work runs on, and the app asks again until it is `"done"`.
 *   3. **Kept.** Per article, for a month: the Colosseum reads the same
 *      for everybody, and nobody should pay the translation twice.
 *
 * Said on screen, every time: where the text comes from, under which
 * licence (CC BY-SA 4.0), and that a translation is a machine's.
 */

import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import { and, eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import dbDefault from "../db/database";
import { tripWikiArticles } from "../db/schema";
import { getCommonsClient, type CommonsClient, type CommonsPhoto } from "./commons-client";
import { askForJson } from "./llm-client";
import type { RoutePhoto } from "./route-photos";
import {
  getWikipediaClient,
  parseArticleUrl,
  type ArticleRef,
  type ArticleSection,
  type WikipediaArticle,
  type WikipediaClient,
} from "./wikipedia-client";

type Db = typeof dbDefault;

/** A strip, not a gallery — the same cap as a route's. */
export const MAX_ARTICLE_PHOTOS = 10;
/** How much of an article is shown; past this the reader has the link. */
export const MAX_ARTICLE_CHARS = 12_000;
/** How much of a foreign article is translated. */
export const MAX_TRANSLATED_CHARS = 6_000;
/** One request to the model: long enough for a paragraph, short enough to finish. */
export const TRANSLATION_CHUNK_CHARS = 1_200;
/** A translated article is kept this long; an untranslated one too. */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** One section's translation may take this long before it counts as failed. */
const TRANSLATION_STEP_TIMEOUT_MS = 120_000;

export type TranslationState = "none" | "pending" | "done" | "failed";

export interface SpotArticleRequest {
  /** The article's address, as the spot carries it. */
  url: string;
}

export interface SpotArticle {
  title: string;
  /** The language of the text shown: "de" after a translation too. */
  language: string;
  /** Which edition the text came from: "it" for a translated Italian article. */
  sourceLanguage: string;
  /** The article shown, on Wikipedia. */
  sourceUrl: string;
  description: string | null;
  sections: ArticleSection[];
  /** True when the text stops before the article does. */
  truncated: boolean;
  translation: TranslationState;
  photos: RoutePhoto[];
  /** "Wikipedia · CC BY-SA 4.0", for the footer. */
  attribution: string;
  license: string;
}

export interface SpotArticleDeps {
  wiki?: WikipediaClient;
  commons?: CommonsClient;
  /** German for a text in another language. Defaults to the llm-service. */
  translate?: (text: string, fromLang: string) => Promise<string>;
  db?: Db;
  now?: () => number;
  /** For a test: wait for the translation instead of answering first. */
  awaitTranslation?: boolean;
}

export const LICENSE = "CC BY-SA 4.0";

/**
 * The article behind a link: cached, German, with pictures — or the
 * original with its translation under way.
 */
export async function spotArticle(req: SpotArticleRequest, deps: SpotArticleDeps = {}): Promise<SpotArticle> {
  const ref = parseArticleUrl(req.url);
  if (!ref) throw APIError.invalidArgument("url is not a Wikipedia article");
  const db = deps.db ?? dbDefault;
  const now = deps.now ?? Date.now;

  // A translation under way answers with what is there, or with the
  // result for a caller that wants to wait; a cached pending answer
  // with no work behind it (a restart) starts the work again.
  const running = inFlight.get(cacheKey(ref));
  const cached = await readCached(db, ref, now());
  if (running) return deps.awaitTranslation || !cached ? await running : cached;
  if (cached && cached.translation !== "pending") return cached;

  const wiki = deps.wiki ?? getWikipediaClient();
  const commons = deps.commons ?? getCommonsClient();

  // German where German exists (§10.4): the local link is the way in,
  // not the text to show.
  let source: WikipediaArticle | null = null;
  if (ref.lang !== "de") {
    const german = await wiki.germanTitle(ref);
    if (german) source = await wiki.article({ lang: "de", title: german });
  }
  if (!source) source = await wiki.article(ref);
  if (!source) throw APIError.notFound("Zu diesem Link gibt es keinen Artikel");

  const { sections, truncated } = clip(source.sections, MAX_ARTICLE_CHARS);
  const photos = await photosOf(source, commons);
  const needsTranslation = source.lang !== "de";
  const article: SpotArticle = {
    title: source.title,
    language: source.lang,
    sourceLanguage: source.lang,
    sourceUrl: source.pageUrl,
    description: source.description,
    sections,
    truncated,
    translation: needsTranslation ? "pending" : "none",
    photos,
    attribution: `Wikipedia · ${LICENSE}`,
    license: LICENSE,
  };
  await writeCached(db, ref, article, now());
  if (!needsTranslation) return article;

  const translate = deps.translate ?? translateWithLlm;
  const work = translateArticle(article, translate)
    .then(async (translated) => {
      await writeCached(db, ref, translated, now());
      return translated;
    })
    .catch(async (err) => {
      log.warn("article translation failed; the original stays", {
        lang: ref.lang, title: ref.title, error: err instanceof Error ? err.message : String(err),
      });
      const failed: SpotArticle = { ...article, translation: "failed" };
      await writeCached(db, ref, failed, now());
      return failed;
    })
    .finally(() => inFlight.delete(cacheKey(ref)));
  inFlight.set(cacheKey(ref), work);
  return deps.awaitTranslation ? await work : article;
}

/** Translations under way, so a second reader does not start a second one. */
const inFlight = new Map<string, Promise<SpotArticle>>();

export function clearArticleWork(): void {
  inFlight.clear();
}

/**
 * The text up to the cap, cut at a section boundary — never mid-sentence
 * — with at least the lead, however long.
 */
export function clip(sections: ArticleSection[], maxChars: number): { sections: ArticleSection[]; truncated: boolean } {
  const out: ArticleSection[] = [];
  let used = 0;
  for (const section of sections) {
    if (out.length > 0 && used + section.text.length > maxChars) {
      return { sections: out, truncated: true };
    }
    out.push(section);
    used += section.text.length;
  }
  return { sections: out, truncated: false };
}

/**
 * The article's pictures: its main one first, then the others in the
 * order the article uses them, as far as Commons calls them usable. A
 * Commons that is down means no pictures and still an article.
 */
async function photosOf(article: WikipediaArticle, commons: CommonsClient): Promise<RoutePhoto[]> {
  const titles = article.images.slice(0, MAX_ARTICLE_PHOTOS * 2);
  if (titles.length === 0) return [];
  let files: CommonsPhoto[];
  try {
    files = await commons.files(titles);
  } catch (err) {
    log.warn("commons did not answer for an article's pictures", {
      title: article.title, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  const byTitle = new Map(files.map((f) => [f.title, f]));
  const ordered = titles.flatMap((t) => (byTitle.has(t) ? [byTitle.get(t)!] : []));
  return ordered.slice(0, MAX_ARTICLE_PHOTOS).map((f) => ({
    thumbUrl: f.thumbUrl,
    thumbWidth: f.thumbWidth,
    thumbHeight: f.thumbHeight,
    pageUrl: f.pageUrl,
    caption: null,
    author: f.author,
    license: f.license,
  }));
}

/**
 * The article in German, section by section, up to the translation
 * cap: what is past it is dropped rather than shown in a language the
 * reader opened the app to avoid. Headings are translated with their
 * section, in one request, so a heading and its text agree.
 */
export async function translateArticle(
  article: SpotArticle,
  translate: (text: string, fromLang: string) => Promise<string>,
): Promise<SpotArticle> {
  const sections: ArticleSection[] = [];
  let used = 0;
  let truncated = article.truncated;
  for (const section of article.sections) {
    if (sections.length > 0 && used + section.text.length > MAX_TRANSLATED_CHARS) {
      truncated = true;
      break;
    }
    const chunks = splitForTranslation(section.text, TRANSLATION_CHUNK_CHARS);
    const parts: string[] = [];
    for (const chunk of chunks) parts.push(await translate(chunk, article.sourceLanguage));
    const heading = section.heading ? await translate(section.heading, article.sourceLanguage) : null;
    sections.push({ heading, level: section.level, text: parts.join("\n\n").trim() });
    used += section.text.length;
  }
  return {
    ...article,
    language: "de",
    sections,
    truncated,
    translation: "done",
    description: article.description ? await translate(article.description, article.sourceLanguage) : null,
  };
}

/**
 * Paragraphs, grouped up to the chunk size; a single paragraph longer
 * than that is cut at a sentence end. One request per chunk keeps each
 * answer inside what the model will write in one go.
 */
export function splitForTranslation(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      push();
      let rest = paragraph;
      while (rest.length > maxChars) {
        const cut = rest.lastIndexOf(". ", maxChars);
        const at = cut > maxChars / 3 ? cut + 1 : maxChars;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      if (rest) chunks.push(rest);
      continue;
    }
    if (current && current.length + paragraph.length + 2 > maxChars) push();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  push();
  return chunks;
}

/** The prompt, exported so a test can read what the model is told. */
export function buildTranslationPrompt(text: string, fromLang: string): string {
  return [
    `Übersetze den folgenden Text aus der Wikipedia (Sprache: ${fromLang}) ins Deutsche.`,
    "Behalte Absätze, Zahlen, Jahreszahlen und Eigennamen bei. Füge nichts hinzu,",
    "lasse nichts weg, erkläre nichts und kommentiere nicht.",
    'Antworte ausschließlich mit JSON in der Form {"text": "<Übersetzung>"}.',
    "",
    "Text:",
    text,
  ].join("\n");
}

async function translateWithLlm(text: string, fromLang: string): Promise<string> {
  const body = await askForJson(buildTranslationPrompt(text, fromLang), TRANSLATION_STEP_TIMEOUT_MS, {
    maxTokens: 2_000,
  });
  const out = (body as { text?: unknown } | null)?.text;
  if (typeof out !== "string" || !out.trim()) throw new Error("llm-service returned no translation");
  return out.trim();
}

function cacheKey(ref: ArticleRef): string {
  return `${ref.lang}:${ref.title}`;
}

async function readCached(db: Db, ref: ArticleRef, now: number): Promise<SpotArticle | null> {
  const [row] = await db
    .select({ article: tripWikiArticles.article, fetched_at: tripWikiArticles.fetched_at })
    .from(tripWikiArticles)
    .where(and(eq(tripWikiArticles.lang, ref.lang), eq(tripWikiArticles.title, ref.title)))
    .limit(1);
  if (!row) return null;
  if (now - new Date(row.fetched_at).getTime() > CACHE_TTL_MS) return null;
  return row.article as SpotArticle;
}

async function writeCached(db: Db, ref: ArticleRef, article: SpotArticle, now: number): Promise<void> {
  const fetchedAt = new Date(now).toISOString();
  await db
    .insert(tripWikiArticles)
    .values({ lang: ref.lang, title: ref.title, article, fetched_at: fetchedAt })
    .onConflictDoUpdate({
      target: [tripWikiArticles.lang, tripWikiArticles.title],
      set: { article, fetched_at: fetchedAt },
    });
}

export const readSpotArticle = api(
  { expose: true, method: "GET", path: "/trip-planner/wikipedia/article", auth: true },
  async (req: SpotArticleRequest): Promise<SpotArticle> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("not logged in");
    requirePermission(auth, "photos.view");
    return spotArticle(req);
  },
);
