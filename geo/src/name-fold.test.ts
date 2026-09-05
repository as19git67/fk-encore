/**
 * The two foldings have to agree, so the test asks both.
 *
 * `foldName` is checked on its own for the rules it promises, and then
 * every one of those names is folded a second time *by PostgreSQL* and
 * compared. That second half is the point of the file: a mismatch there
 * means the SQL filter drops rows the TypeScript comparison would have
 * kept, and the symptom would be "search sometimes finds nothing",
 * which is close to unfindable by reading code.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import pg from "pg";
import { foldName, foldNameSql, foldedLikePattern } from "./name-fold.ts";

/**
 * Names chosen for the ways they differ, not for the places they are:
 * German umlauts and ß, Portuguese and French accents, Polish and Czech
 * letters, the multi-character expansions, double spaces, and leading
 * and trailing whitespace.
 */
const NAMES = [
  "Café Zentral",
  "Straßenbahnmuseum",
  "Grüner Hügel",
  "São Bento",
  "Musée d'Orsay",
  "Łazienki Królewskie",
  "Náměstí Míru",
  "Æbleskiver Bageri",
  "Œuvre Notre-Dame",
  "Museum  am   Platz",
  "  Beispielhaus  ",
  "100 % Bio",
  "Ærø Køkken",
  "ÄÖÜ Großhandel",
];

test("folds case, diacritics and whitespace", () => {
  assert.equal(foldName("Café Zentral"), "cafe zentral");
  assert.equal(foldName("Straßenbahnmuseum"), "strassenbahnmuseum");
  assert.equal(foldName("Museum  am   Platz"), "museum am platz");
  assert.equal(foldName("  Beispielhaus  "), "beispielhaus");
  assert.equal(foldName("ÄÖÜ Großhandel"), "aou grosshandel");
});

test("keeps punctuation, because that is a judgement about names", () => {
  assert.equal(foldName("St. Anna"), "st. anna");
  assert.equal(foldName("Musée d'Orsay"), "musee d'orsay");
});

test("is idempotent — folding a folded name changes nothing", () => {
  for (const name of NAMES) {
    assert.equal(foldName(foldName(name)), foldName(name), name);
  }
});

test("escapes LIKE wildcards in the search term", () => {
  assert.equal(foldedLikePattern(foldName("100 % Bio")), "%100 \\% bio%");
  assert.equal(foldedLikePattern("a_b"), "%a\\_b%");
});

test("PostgreSQL folds every name the same way JavaScript does", async (t) => {
  const client = new pg.Client({
    host: process.env.GEO_DB_HOST ?? "geo-db",
    port: parseInt(process.env.GEO_DB_PORT ?? "5432", 10),
    user: process.env.GEO_DB_USER ?? "postgres",
    password: process.env.GEO_DB_PASSWORD ?? "postgres",
    database: process.env.GEO_DB_ADMIN_DB ?? "postgres",
  });
  try {
    await client.connect();
  } catch {
    // Same reasoning as postgisAvailable(): a red suite that only means
    // "no database on this machine" trains people to ignore red suites.
    t.skip("no PostgreSQL reachable");
    return;
  }
  after(async () => {
    await client.end().catch(() => {});
  });

  const res = await client.query<{ folded: string }>(
    `SELECT ${foldNameSql("value")} AS folded FROM unnest($1::text[]) AS value`,
    [NAMES],
  );
  assert.equal(res.rows.length, NAMES.length);
  NAMES.forEach((name, i) => {
    assert.equal(res.rows[i].folded, foldName(name), `SQL and JS disagree about ${name}`);
  });
});
