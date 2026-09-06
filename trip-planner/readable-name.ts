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

  // Readable as it stands. This is the ordinary European case, and it
  // must not be replaced by an English name the mappers added for
  // tourists — "Marienplatz" is what the signs and everybody else say.
  if (hasLatinLetters(local)) return { display: local, local: null };

  const readable = de ?? en;
  if (!readable) return { display: local, local: null };
  return { display: readable, local };
}

/** The display name on its own, for callers with nowhere to put the local one. */
export function displayName(spot: LocalizedNames): string | null {
  return readableName(spot).display;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
