/**
 * Reading an article from Wikipedia (§25, stage C).
 *
 * Until now the article was a link: "Artikel lesen" opened Safari, and
 * where the article was Italian the footer said so and left the
 * reading to iOS. The text of an article is the one thing about a
 * place the map does not hold — what it is, why it is there, what
 * happened in it — and it is exactly what somebody deciding between
 * two churches wants before voting (§3.8). So the article comes into
 * the app: the German one where it exists, otherwise the local one,
 * translated by the llm-service (`wiki-article.ts`).
 *
 * This file is the client and the parsers, and nothing else: which
 * article, what it says, which pictures it uses. Pure functions where
 * a decision is made, so they can be tested without Wikipedia.
 *
 * **What leaves the house** is the title of a public article — never
 * who asked. The pictures the phone loads straight from Wikimedia.
 */

/** Wikimedia asks every client to say who it is. */
const USER_AGENT = "fk-encore/trip-planner (https://github.com/as19git67/fk-encore) Node.js";
const TIMEOUT_MS = 10_000;

/** Where an article lives: its language edition and its title. */
export interface ArticleRef {
  lang: string;
  title: string;
}

/** One part of an article, as the reader shows it. */
export interface ArticleSection {
  /** Null for the lead, which has no heading. */
  heading: string | null;
  /** 2 for `== Geschichte ==`, 3 for `=== Mittelalter ===`; 1 for the lead. */
  level: number;
  text: string;
}

export interface WikipediaArticle extends ArticleRef {
  pageUrl: string;
  /** The page's current revision id, so a later look can tell whether it changed. */
  revision: number | null;
  /** Wikidata's one-line description where the article has one. */
  description: string | null;
  sections: ArticleSection[];
  /** The article's main picture, as a "File:…" title, where it has one. */
  mainImage: string | null;
  /** The files the article uses, as "File:…" titles, in article order. */
  images: string[];
}

export interface WikipediaClient {
  /** The German article for one in another language, or null. */
  germanTitle(ref: ArticleRef): Promise<string | null>;
  /** The article, or null when the title names no page. */
  article(ref: ArticleRef): Promise<WikipediaArticle | null>;
  /** The page's current revision id alone — the cheap question "did it change?" */
  revision(ref: ArticleRef): Promise<number | null>;
}

/** Wikipedia did not answer. The caller shows the link it always had. */
export class WikipediaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikipediaUnavailableError";
  }
}

export class HttpWikipediaClient implements WikipediaClient {
  async germanTitle(ref: ArticleRef): Promise<string | null> {
    if (ref.lang === "de") return ref.title;
    const url = apiUrl(ref.lang);
    url.searchParams.set("prop", "langlinks");
    url.searchParams.set("lllang", "de");
    url.searchParams.set("titles", ref.title);
    return parseGermanTitle(await getJson(url));
  }

  async article(ref: ArticleRef): Promise<WikipediaArticle | null> {
    const url = apiUrl(ref.lang);
    url.searchParams.set("prop", "extracts|pageimages|images|info|description");
    url.searchParams.set("explaintext", "1");
    url.searchParams.set("exsectionformat", "wiki");
    url.searchParams.set("exlimit", "1");
    url.searchParams.set("piprop", "name");
    url.searchParams.set("inprop", "url");
    url.searchParams.set("imlimit", "50");
    url.searchParams.set("titles", ref.title);
    return parseArticle(await getJson(url), ref.lang);
  }

  async revision(ref: ArticleRef): Promise<number | null> {
    const url = apiUrl(ref.lang);
    url.searchParams.set("prop", "info");
    url.searchParams.set("titles", ref.title);
    return parseRevision(await getJson(url));
  }
}

function apiUrl(lang: string): URL {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("redirects", "1");
  return url;
}

async function getJson(url: URL): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new WikipediaUnavailableError(`${url.host} answered ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof WikipediaUnavailableError) throw err;
    throw new WikipediaUnavailableError(err instanceof Error ? err.message : "wikipedia unavailable");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "it" and "Colosseo" out of `https://it.wikipedia.org/wiki/Colosseo`,
 * the mobile host included; null for anything that is not an article
 * on Wikipedia. The portal (`www.`) names no language and no article.
 */
export function parseArticleUrl(value: string): ArticleRef | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".wikipedia.org")) return null;
  const lang = host.replace(/\.m\.wikipedia\.org$/, "").replace(/\.wikipedia\.org$/, "");
  if (!lang || lang === "www" || lang === "m" || !/^[a-z]{2,3}(-[a-z0-9-]+)?$/.test(lang)) return null;
  const match = /^\/wiki\/(.+)$/.exec(url.pathname);
  if (!match) return null;
  let title: string;
  try {
    title = decodeURIComponent(match[1]).replace(/_/g, " ").trim();
  } catch {
    return null;
  }
  if (!title) return null;
  return { lang, title };
}

/** The German title out of a `langlinks` answer, or null. */
export function parseGermanTitle(body: unknown): string | null {
  const page = firstPage(body);
  if (!page) return null;
  const links = Array.isArray(page.langlinks) ? page.langlinks : [];
  for (const link of links) {
    if (link && typeof link === "object" && (link as { lang?: unknown }).lang === "de") {
      const title = (link as { title?: unknown }).title;
      if (typeof title === "string" && title.trim()) return title.trim();
    }
  }
  return null;
}

/** The revision id out of an `info` answer, or null for a missing page. */
export function parseRevision(body: unknown): number | null {
  const page = firstPage(body);
  if (!page || page.missing === true) return null;
  return typeof page.lastrevid === "number" ? page.lastrevid : null;
}

/** The article out of a `query` answer, or null for a missing page. */
export function parseArticle(body: unknown, lang: string): WikipediaArticle | null {
  const page = firstPage(body);
  if (!page || page.missing === true || typeof page.title !== "string") return null;
  const extract = typeof page.extract === "string" ? page.extract : "";
  const mainImage = typeof page.pageimage === "string" ? fileTitle(page.pageimage) : null;
  const images = (Array.isArray(page.images) ? page.images : [])
    .map((img) => (img && typeof img === "object" ? (img as { title?: unknown }).title : null))
    .filter((t): t is string => typeof t === "string")
    .map(fileTitle)
    .filter(isPhotograph);
  return {
    lang,
    title: page.title,
    revision: typeof page.lastrevid === "number" ? page.lastrevid : null,
    pageUrl: typeof page.fullurl === "string"
      ? page.fullurl
      : `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    description: typeof page.description === "string" && page.description.trim()
      ? page.description.trim()
      : null,
    sections: parseSections(extract),
    mainImage,
    images: mainImage && isPhotograph(mainImage)
      ? [mainImage, ...images.filter((i) => i !== mainImage)]
      : images,
  };
}

function firstPage(body: unknown): Record<string, unknown> | null {
  const query = (body as { query?: { pages?: unknown } } | null)?.query;
  const pages = query?.pages;
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const page = pages[0];
  return page && typeof page === "object" ? (page as Record<string, unknown>) : null;
}

/**
 * The namespace as Commons spells it: an article on de.wikipedia
 * lists its pictures as "Datei:…", on fr.wikipedia as "Fichier:…", and
 * Commons answers to "File:…" only. A bare page-image name has no
 * namespace at all.
 */
export function fileTitle(title: string): string {
  const trimmed = title.trim().replace(/_/g, " ");
  const colon = trimmed.indexOf(":");
  const name = colon > 0 && colon < 20 ? trimmed.slice(colon + 1).trim() : trimmed;
  return `File:${name}`;
}

/**
 * Whether a file an article uses is a photograph worth a strip: no
 * icons, flags, maps, coats of arms, sound files, and no vector
 * graphics at all — an article's pictures are mostly those, and a
 * strip of three flags and a locator map is a strip of nothing.
 */
export function isPhotograph(title: string): boolean {
  const name = title.replace(/^File:/, "");
  if (!/\.(jpe?g|png|webp|tiff?)$/i.test(name)) return false;
  return !/(^|[\s_-])(flag|icon|logo|map|karte|wappen|coat[\s_]of[\s_]arms|stemma|bandera|drapeau|blason|escudo|brasão|pictogram|symbol|locator|lage|position|disambig|commons-|wiki|crystal|nuvola|gnome|emblem|seal)([\s_.-]|$)/i.test(name);
}

/**
 * Sections that are an article's apparatus, not its text: references,
 * further reading, links. Named in the languages a European trip is
 * likely to meet; anything else is kept, which errs on the side of
 * showing too much rather than a page that ends mid-story.
 */
const APPARATUS = new Set([
  "einzelnachweise", "literatur", "weblinks", "siehe auch", "anmerkungen", "fußnoten", "quellen", "belege",
  "references", "external links", "see also", "notes", "bibliography", "further reading", "sources",
  "footnotes", "citations", "gallery", "galerie", "bildergalerie",
  "note", "bibliografia", "collegamenti esterni", "voci correlate", "altri progetti", "galleria d'immagini",
  "références", "liens externes", "voir aussi", "bibliographie", "notes et références", "annexes", "articles connexes",
  "referencias", "enlaces externos", "véase también", "bibliografía", "notas",
  "referências", "ligações externas", "ver também", "notas e referências",
  "referenties", "externe links", "zie ook", "literatuur", "bronnen", "noten",
  "reference", "externí odkazy", "související články", "odkazy", "literatura", "poznámky",
  "przypisy", "linki zewnętrzne", "zobacz też", "bibliografia", "uwagi",
]);

/**
 * The plain-text extract into sections. The lead has no heading; a
 * heading with no text under it (a section that was only a table or a
 * gallery) is dropped; the apparatus at the end is dropped with
 * everything below it, since nothing that follows "Einzelnachweise" is
 * the article any more.
 */
export function parseSections(extract: string): ArticleSection[] {
  const out: ArticleSection[] = [];
  let heading: string | null = null;
  let level = 1;
  let lines: string[] = [];
  let apparatus = false;
  const flush = () => {
    const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text) out.push({ heading, level, text });
    lines = [];
  };
  for (const raw of extract.split("\n")) {
    const match = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(raw);
    if (match) {
      flush();
      heading = match[2].trim();
      level = match[1].length;
      // Below a dropped top-level section everything is apparatus;
      // a dropped subsection takes only itself.
      if (APPARATUS.has(heading.toLowerCase())) {
        if (level === 2) apparatus = true;
        heading = null;
        lines = [];
        level = 0;
        continue;
      }
      if (level === 2) apparatus = false;
      continue;
    }
    if (apparatus || level === 0) continue;
    lines.push(raw);
  }
  flush();
  return out;
}

let client: WikipediaClient | null = null;

export function getWikipediaClient(): WikipediaClient {
  return client ?? (client = new HttpWikipediaClient());
}

export function setWikipediaClient(next: WikipediaClient): void {
  client = next;
}

export function resetWikipediaClient(): void {
  client = null;
}
