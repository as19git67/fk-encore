/**
 * Turning what OpenStreetMap knows about a place into links a person
 * can open (§10.4).
 *
 * The `wikipedia` tag has been on every spot since the beginning and
 * only ever counted towards the prominence score — a place either had
 * an article or it did not, and the article itself was thrown away.
 * That is the one link a traveller standing in front of a building
 * actually wants, so it is built here rather than in the app: the
 * pool, the day and the search all show the same spot, and a URL
 * assembled three times is a URL that eventually differs.
 */

/**
 * The article URL for an OSM `wikipedia` tag, or null when the tag
 * says nothing that can be turned into one.
 *
 * The tag is `lang:Article title` by convention ("de:Schloss
 * Beispiel"), and occasionally a full URL. A bare title with no
 * language deliberately yields nothing: guessing `de` for a place in
 * Kyoto would send the traveller to an article that does not exist,
 * and a missing link is better than a wrong one (§15.3).
 */
export function wikipediaUrl(tag: string | null | undefined): string | null {
  const value = (tag ?? "").trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    // Only a Wikipedia URL: the tag is occasionally misused for the
    // operator's own homepage, and calling that "Wikipedia" on screen
    // would be a small lie in a section people trust.
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "wikipedia.org" && !host.endsWith(".wikipedia.org")) return null;
    return url.toString();
  }

  const match = /^([A-Za-z]{2,3}(?:-[A-Za-z0-9-]+)?):(.+)$/.exec(value);
  if (!match) return null;
  const [, lang, rawTitle] = match;
  const title = rawTitle.trim();
  if (!title) return null;

  return `https://${lang.toLowerCase()}.wikipedia.org/wiki/${encodeTitle(title)}`;
}

/**
 * The article for a spot, in German where German exists (§10.4).
 *
 * The `wikipedia` tag names the article **in the local language** — in
 * Rome `it:Colosseo`, in Lisbon `pt:Mosteiro dos Jerónimos`. That is
 * the right link for somebody who reads Italian and a dead end for
 * everybody else, and the answer is usually right there in the data:
 * OpenStreetMap's convention is a second tag, `wikipedia:de`, holding
 * the title of the German article for the same place.
 *
 * So German wins when it exists, and nothing is guessed when it does
 * not: the local article stays, and the app says which language it is
 * in rather than sending somebody into a page they cannot read without
 * warning. Deriving a German title from an Italian one — or assuming
 * the same title exists on de.wikipedia — would be inventing a link,
 * and a link that 404s is worse than one in the wrong language
 * (§15.3).
 */
export function articleUrl(tags: {
  wikipedia?: string | null;
  /** The `wikipedia:de` tag: a bare title, occasionally `de:Title`. */
  wikipediaDe?: string | null;
}): string | null {
  const german = (tags.wikipediaDe ?? "").trim();
  if (german) {
    // The tag is a bare title by convention, but `de:Kolosseum` and a
    // full URL both turn up. `wikipediaUrl` already knows the last two
    // shapes, so only the bare title needs prefixing.
    const qualified = /^https?:\/\//i.test(german) || /^[A-Za-z]{2,3}(-[A-Za-z0-9-]+)?:/.test(german)
      ? german
      : `de:${german}`;
    const url = wikipediaUrl(qualified);
    if (url) return url;
  }
  return wikipediaUrl(tags.wikipedia);
}

/**
 * Percent-encoding as MediaWiki writes it: spaces become underscores,
 * and the punctuation that appears in article titles unescaped stays
 * unescaped, so the link reads like the article it points at.
 */
function encodeTitle(title: string): string {
  return encodeURIComponent(title.replace(/ /g, "_"))
    .replace(/%2F/g, "/")
    .replace(/%3A/g, ":")
    .replace(/%2C/g, ",")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%27/g, "'")
    .replace(/%21/g, "!")
    .replace(/%2A/g, "*");
}
