/**
 * Getting readable text out of a shared page (§9.3, stage 2).
 *
 * Navigation, cookie banners, related-article blocks and comments bloat
 * a page and crowd out the part that names places. For a local model
 * that is not cosmetic: context is the scarcest resource it has, and
 * noise displaces content.
 *
 * The **usual** path does not come through here at all. Stage 1 has the
 * share extension run a small script inside the already-open page and
 * hand over its visible text, which the browser has already stripped of
 * markup — and which has already solved JavaScript rendering, cookie
 * walls, logins and bot blocks along the way. This module is for the
 * fallback, where only a URL arrived and the server fetched the HTML
 * itself.
 *
 * It is a coarse Readability rather than a real one, and deliberately:
 * a wrong guess costs a few extracted names, not a wrong plan, and
 * every name is checked against a verbatim quote afterwards anyway.
 */

/**
 * How much text the model is given.
 *
 * A long-form travel article runs to perhaps 20 000 characters; beyond
 * that a page is a listing or an archive, where the interesting part is
 * at the top in any case. Cutting is better than a truncated response
 * from a model that ran out of context mid-answer.
 */
export const MAX_ARTICLE_CHARS = 24_000;

/**
 * Elements whose *content* is never prose, and which swallow the rest
 * of the document when they are left unclosed.
 *
 * That second half is the important one. A page cut off mid-script — or
 * one whose closing tag the fetch never reached — would otherwise leave
 * a wall of JavaScript in the middle of the article, and the model
 * would dutifully look for places in it. A browser reads an unclosed
 * `<script>` as running to the end of the document, and so does this.
 */
const OPAQUE_ELEMENTS = ["script", "style", "noscript", "svg", "iframe", "template"];

/**
 * Elements that are furniture rather than article — but only as a
 * matched pair.
 *
 * Unlike the opaque ones, a stray unclosed `<nav>` must **not** swallow
 * what follows: on a page whose markup is a little broken, that would
 * throw the article away and report an empty page. A lone tag becomes a
 * line break and nothing more.
 */
const FURNITURE_ELEMENTS = ["form", "nav", "header", "footer", "aside"];

/** Tags whose boundaries are line breaks once the markup is gone. */
const BLOCK_ELEMENTS =
  /<\/?(?:p|div|section|article|h[1-6]|li|ul|ol|tr|td|th|br|blockquote|figcaption|dd|dt)\b[^>]*>/gi;

/**
 * HTML in, readable text out.
 *
 * Order matters: whole elements go first (with their content), then
 * block boundaries become newlines, then what is left of the markup is
 * removed. Doing it the other way round would leave a page's scripts as
 * a wall of JavaScript in the middle of the article.
 */
export function articleTextFromHtml(html: string): string {
  let text = html;
  for (const tag of OPAQUE_ELEMENTS) {
    // `|$` is what makes an unclosed element run to the end.
    text = text.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:</${tag}\\s*>|$)`, "gi"),
      "\n",
    );
    text = text.replace(new RegExp(`</?${tag}\\b[^>]*>`, "gi"), "\n");
  }
  for (const tag of FURNITURE_ELEMENTS) {
    text = text.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi"),
      "\n",
    );
    text = text.replace(new RegExp(`</?${tag}\\b[^>]*>`, "gi"), "\n");
  }
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(BLOCK_ELEMENTS, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  return normaliseWhitespace(decodeEntities(text));
}

/**
 * Tidy text from either route into the shape the prompt expects, and
 * cut it to length.
 *
 * The cut lands on a paragraph boundary where one is near the limit, so
 * the model is not handed half a sentence to reason about.
 */
export function prepareArticleText(text: string, maxChars = MAX_ARTICLE_CHARS): string {
  const clean = normaliseWhitespace(text);
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd();
}

/**
 * Is this quote really in the page?
 *
 * The check that makes the whole extraction trustworthy (§9.3 stage 3).
 * A model asked for a verbatim quote alongside each name will
 * occasionally produce a name the page never mentioned — and it cannot
 * produce the quote to go with it, so the entry falls out
 * mechanically.
 *
 * Tolerant about typography, strict about words. Models re-type curly
 * quotes as straight ones, en dashes as hyphens and non-breaking spaces
 * as spaces; treating those as forgeries would throw away good entries
 * for nothing. What it will not tolerate is different words, which is
 * the only thing invention ever looks like.
 */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const needle = normaliseForComparison(quote);
  // Anything this short is not evidence — "das" appears in every German
  // page ever written, and would wave through a name nobody wrote.
  if (needle.length < MIN_QUOTE_CHARS) return false;
  return normaliseForComparison(source).includes(needle);
}

/** Below this a quote proves nothing, because it matches everything. */
export const MIN_QUOTE_CHARS = 12;

/**
 * Collapse the differences that are notation rather than wording:
 * case, whitespace, the several kinds of quotation mark and dash.
 */
function normaliseForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚′`´]/g, "'")
    .replace(/[“”„″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whitespace as the prompt wants it: no runs of spaces, no more than
 * one blank line, no trailing space at the end of a line.
 */
function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The handful of entities that actually turn up in prose, plus the
 * numeric forms.
 *
 * Not a full table on purpose: an unknown entity left as `&hellip;`
 * costs a slightly odd-looking quote, while pulling in a whole HTML
 * parser for the fallback path costs a dependency.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  aacute: "á",
  agrave: "à",
  acirc: "â",
  aring: "å",
  atilde: "ã",
  ccedil: "ç",
  iacute: "í",
  igrave: "ì",
  icirc: "î",
  ntilde: "ñ",
  oacute: "ó",
  ograve: "ò",
  ocirc: "ô",
  otilde: "õ",
  oslash: "ø",
  uacute: "ú",
  ugrave: "ù",
  ucirc: "û",
  Eacute: "É",
  Aacute: "Á",
  Ccedil: "Ç",
  Oacute: "Ó",
  Uacute: "Ú",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  euro: "€",
  szlig: "ß",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Surrogates and out-of-range values would throw; leaving the
      // entity in place is the harmless answer.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}
