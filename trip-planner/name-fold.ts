/**
 * Comparing place names the way people write them.
 *
 * Searching for a place by name is the one geo query where the input
 * comes from a person rather than from a coordinate: a name copied out
 * of a blog post, typed into a search field, or read off a screenshot
 * by OCR. It will differ from what OpenStreetMap carries in case, in
 * spacing, and above all in diacritics — "Cafe Zentral" for
 * `Café Zentral`, "Sao Bento" for `São Bento`.
 *
 * Two sides have to agree on that folding: the SQL that narrows the
 * rows and the TypeScript that decides whether a returned row really is
 * the place asked for. Writing them twice is how they drift apart, so
 * both are generated from the single table below — one source, two
 * renderings — and `name-fold.test.ts` asserts a real database agrees
 * with the JavaScript character for character.
 *
 * **This module exists twice, byte for byte:** `geo/src/name-fold.ts`
 * and `trip-planner/name-fold.ts`. The two live in different build
 * contexts — geo ships as its own container and copies only its own
 * `src/` — so neither side can import the other, and a deliberate copy
 * with a comment naming its counterpart is how this repo handles that
 * elsewhere. A comment is easy to ignore, so
 * `trip-planner/name-fold-copy.test.ts` compares the two files
 * outright: edit one and the suite goes red until the other matches.
 *
 * The folding is deliberately shallow. It removes the differences that
 * are pure notation; it does not stem, transliterate scripts, or try to
 * understand that "St." and "Sankt" are the same word. Nor does it
 * equate `München` with "Muenchen": the umlaut folds to the bare vowel,
 * because the other direction cannot be undone safely — a rule turning
 * "ue" into "u" would also turn "Bauer" into "Bar". Anything
 * cleverer starts merging places that only sound alike, and a wrong
 * merge is worse than a miss: a miss is visible and a merge is not.
 */

/**
 * Characters that fold to more than one letter, applied before the
 * one-to-one table because they change the string's length.
 *
 * `ß → ss` is the case that matters in German; the rest are the
 * European letters that a keyboard without them spells out.
 */
const EXPANSIONS: ReadonlyArray<readonly [string, string]> = [
  ["ß", "ss"],
  ["æ", "ae"],
  ["œ", "oe"],
];

/**
 * One-to-one replacements, as two strings of equal length so that both
 * `String.prototype.replace` and SQL's `translate` can be driven from
 * them.
 *
 * Lower case only: both sides lower-case first, and every character
 * here lower-cases the way you would expect.
 */
const FOLD_FROM = "àáâãäåāăąçćĉċčďđèéêëēĕėęěìíîïĩīĭįıñńņňòóôõöøōŏőùúûüũūŭůűųýÿŷłśŝşšțťžźż";
const FOLD_TO___ = "aaaaaaaaacccccddeeeeeeeeeiiiiiiiiinnnnooooooooouuuuuuuuuuyyylssssttzzz";

if (FOLD_FROM.length !== FOLD_TO___.length) {
  // A typo here would silently truncate `translate`'s mapping in SQL,
  // leaving the two sides disagreeing about a handful of letters.
  throw new Error(
    `name fold table is lopsided: ${FOLD_FROM.length} sources, ${FOLD_TO___.length} targets`,
  );
}

/**
 * The comparable form of a name: lower case, diacritics resolved,
 * runs of whitespace collapsed, ends trimmed.
 *
 * Punctuation stays. "St. Anna" and "St Anna" are not made equal here —
 * that is a judgement about names, not about notation, and it belongs
 * to whoever is deciding what counts as the same place.
 */
export function foldName(name: string): string {
  let folded = name.toLowerCase();
  for (const [from, to] of EXPANSIONS) folded = folded.split(from).join(to);
  let out = "";
  for (const char of folded) {
    const index = FOLD_FROM.indexOf(char);
    out += index === -1 ? char : FOLD_TO___[index];
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The same folding as a SQL expression over `expr`.
 *
 * Whitespace is collapsed with `regexp_replace` and the ends trimmed,
 * mirroring the JavaScript exactly — a name stored as `"Museum  am
 * Platz"` must fold to the same string on both sides or the SQL filter
 * would drop a row the TypeScript comparison would have accepted.
 *
 * `expr` is interpolated, so it must be SQL the caller wrote, never
 * user input. Every call site below passes a column or a `tags->>`
 * lookup.
 */
export function foldNameSql(expr: string): string {
  let inner = `lower(${expr})`;
  for (const [from, to] of EXPANSIONS) {
    inner = `replace(${inner}, ${quote(from)}, ${quote(to)})`;
  }
  return `btrim(regexp_replace(translate(${inner}, ${quote(FOLD_FROM)}, ${quote(FOLD_TO___)}), '\\s+', ' ', 'g'))`;
}

/**
 * Escape a string literal for interpolation into SQL. Only ever called
 * with the constants above, but a literal built by string concatenation
 * deserves the guard regardless.
 */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Turn a folded name into a LIKE pattern that matches it anywhere.
 *
 * `%` and `_` in the search term are escaped: someone looking for a
 * café called "100 %" should not get every row in the region.
 */
export function foldedLikePattern(foldedName: string): string {
  return `%${foldedName.replace(/([\\%_])/g, "\\$1")}%`;
}
