import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { flattenTaxonomy } from "./taxonomy";

/**
 * The classifier reads its label set from the `document_categories` table
 * (`loadTaxonomyForClassifier`) but its hints from `taxonomy.ts`, matched by
 * slug. The two are only ever brought together by the seed, which until
 * migration 0152 inserted rows and never removed or updated them. A category
 * dropped from `taxonomy.ts` therefore stayed selectable in the database with
 * no hint describing it, and the cloud audit — which reads `taxonomy.ts` —
 * could never agree with it: the 2026-08-24 run found `vertraege-agbs` and
 * `betriebliche-unterlagen` sitting at 0 %.
 *
 * Migration 0152 prunes what had already drifted. These pin the two halves of
 * keeping it from drifting again.
 */
describe("taxonomy / database drift", () => {
  const migration = readFileSync(
    join(import.meta.dirname, "..", "db", "migrations", "postgres",
      "0152_prune_orphaned_document_categories.sql"),
    "utf8",
  );
  const seed = readFileSync(
    join(import.meta.dirname, "..", "db", "seed.ts"),
    "utf8",
  );

  it("keeps every current slug out of the migration's prune list", () => {
    // The migration deletes categories whose slug is NOT in its list, so a slug
    // missing from it would delete a live category and move its documents to
    // sonstiges. A snapshot that no longer covers the taxonomy is worse than no
    // snapshot: it silently destroys categories the taxonomy still defines.
    const listed = new Set(
      (migration.split("WHERE slug NOT IN (")[1].split(")")[0].match(/'([a-z0-9-]+)'/g) ?? [])
        .map((s) => s.slice(1, -1)),
    );
    const missing = flattenTaxonomy()
      .map((r) => r.slug)
      .filter((slug) => !listed.has(slug));
    expect(missing, `slugs the migration would delete: ${missing.join(", ")}`).toEqual([]);
  });

  it("moves documents off an orphan before deleting it", () => {
    // The foreign key is ON DELETE SET NULL, so deleting outright leaves the
    // document with no category — and runClassify's category guard skips any
    // document whose category is pinned, so a re-classify would never give it
    // one back. The UPDATE has to come first.
    const updateAt = migration.indexOf("UPDATE documents");
    const deleteAt = migration.indexOf("DELETE FROM document_categories");
    expect(updateAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(updateAt);
    expect(migration.slice(updateAt, deleteAt)).toContain("'sonstiges'");
  });

  it("has the seed update presentation columns of categories it already has", () => {
    // Renaming a category in taxonomy.ts used to reach fresh installs only.
    expect(seed).toMatch(/\.update\(schema\.documentCategories\)[\s\S]{0,200}name: row\.name/);
  });

  it("has the seed report categories the taxonomy no longer defines", () => {
    expect(seed).toContain("not in the seed taxonomy and have no hint");
  });

  it("leaves slugs alone in the seed — they are the identity, not a label", () => {
    // A slug change means a different category and needs a migration that
    // decides what happens to the documents attached to the old one.
    const updates = seed.match(/\.update\(schema\.documentCategories\)[\s\S]{0,240}?\.where/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).not.toMatch(/set\([^)]*slug:/);
  });
});
