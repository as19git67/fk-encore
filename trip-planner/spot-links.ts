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
