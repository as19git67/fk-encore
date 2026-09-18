import { foldName } from "./name-fold";

/**
 * Choosing the name a traveller can actually read (§10.4, §15.3).
 *
 * OpenStreetMap's `name` is the name **in the local language**, and
 * that is the right primary source almost everywhere in Europe. In
 * Tokyo it is 東京国立博物館, in Jerusalem מוזיאון ישראל, in Athens
 * Εθνικό Αρχαιολογικό Μουσείο. A plan whose every row is in a script
 * the reader does not know is not a plan — and until now the fallback
 * only fired when `name` was missing entirely, so it never fired in
 * exactly the places it was written for.
 *
 * The rule here is deliberately about **script, not country**: a name
 * with no letters the reader's alphabet shares is unreadable, wherever
 * it is. Nothing is translated and nothing is transliterated by us —
 * `name:de` and `name:en` are what the mappers themselves wrote, and if
 * neither exists the local name stays, because a name that is hard to
 * read still beats no name at all (§15.3: never invent).
 *
 * **The second rule is about exonyms.** A German traveller calls the
 * Colosseo the Kolosseum, Praha Prag and Firenze Florenz, and a plan
 * that insists on the local spelling is a plan whose rows nobody says
 * out loud. So where `name:de` really differs from the local name, it
 * becomes the one on the card and the local one is kept beside it —
 * because that is still what is written on the sign and asked for at
 * the ticket desk.
 *
 * That rule is deliberately narrow, and the narrowing is `wellKnown`.
 * A place with an exonym is a place the world has written about, and in
 * OpenStreetMap that shows as a `wikidata` or `wikipedia` tag. Without
 * one, a `name:de` is usually a well-meaning word-for-word translation
 * of a village church — "Kirche des heiligen Nikolaus" for `Église
 * Saint-Nicolas` — which stands on no sign and is on no map the
 * traveller will hold. There the local name stays.
 */

/**
 * Does this text contain any Latin letters?
 *
 * The test is for the reader, not for the language: "Café Beispiel"
 * and "Tokyo Skytree" pass, 東京国立博物館 and מוזיאון ישראל do not.
 * Digits and punctuation do not count — "1-2-3" is not a readable name
 * in any alphabet.
 */
export function hasLatinLetters(text: string): boolean {
  return /\p{Script=Latin}/u.test(text);
}

export interface LocalizedNames {
  name: string | null;
  nameDe: string | null;
  nameEn: string | null;
  /**
   * What the world has written about the place. Neither is a name, and
   * both are read here as one thing: a `wikidata` item or a `wikipedia`
   * article means somewhere written about in other languages, and only
   * there is a German name taken for an exonym rather than for
   * somebody's translation. Both absent is the cautious case, and the
   * cautious answer is the local name.
   *
   * Passed as the tags rather than as a `wellKnown` flag so that every
   * caller handing over an OSM spot gets the same answer without having
   * to know the rule — the pool, the search, the place lookup and the
   * food list all name one place the same way.
   */
  wikidataQid?: string | null;
  wikipedia?: string | null;
}

/**
 * The name to show, and the local one worth keeping beside it.
 *
 * `display` is what goes on the card; `local` is the original, set only
 * when it differs from the display name. Standing in front of the
 * building, the sign says the local one — so it is worth carrying even
 * when it cannot be read, which is why this answers both rather than
 * choosing one and forgetting the other.
 */
export function readableName(spot: LocalizedNames): {
  display: string | null;
  local: string | null;
} {
  const local = clean(spot.name);
  const de = clean(spot.nameDe);
  const en = clean(spot.nameEn);

  // Nothing local: the translations are all there is, and German comes
  // first because that is the app's language.
  if (!local) return { display: de ?? en, local: null };

  // Readable as it stands. This is the ordinary European case.
  if (hasLatinLetters(local)) {
    // …with one exception: a real German exonym for a place that has
    // one. English never gets this promotion — "Marienplatz" is what
    // the signs and everybody else say, and `name:en` is often just a
    // label a mapper added for tourists.
    if (wellKnown(spot) && de && !sameName(de, local)) return { display: de, local };
    return { display: local, local: null };
  }

  const readable = de ?? en;
  if (!readable) return { display: local, local: null };
  return { display: readable, local };
}

/** The display name on its own, for callers with nowhere to put the local one. */
export function displayName(spot: LocalizedNames): string | null {
  return readableName(spot).display;
}

/** Somewhere the world has written about; see `LocalizedNames`. */
function wellKnown(spot: LocalizedNames): boolean {
  return Boolean(spot.wikidataQid?.trim() || spot.wikipedia?.trim());
}

/**
 * Are these two the same name written twice?
 *
 * Folded rather than compared literally: `name:de` is very often the
 * local name again, occasionally with different capitalisation or
 * without its accents, and promoting "Cafe Central" over `Café
 * Central` would put the worse spelling on the card and then claim the
 * better one is a different place.
 */
function sameName(a: string, b: string): boolean {
  return foldName(a) === foldName(b);
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
