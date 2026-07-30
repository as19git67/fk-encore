import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { and, eq, isNull } from "drizzle-orm";

import db from "../db/database";
import { documentCategories, documentCategorySuggestions } from "../db/schema";
import { acceptCategorySuggestion } from "./documents";

const USER_ID = 990901;

function setAuth() {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(USER_ID),
    permissions: ["module.documents", "documents.manage_taxonomy"],
  });
}

beforeEach(async () => {
  setAuth();
  await db.delete(documentCategorySuggestions);
  await db.delete(documentCategories).where(eq(documentCategories.slug, "beruf-test-parent"));
  await db.delete(documentCategories).where(eq(documentCategories.slug, "beruf-betriebliche-unterlagen-test"));
  await db.delete(documentCategories).where(eq(documentCategories.slug, "betriebliche-unterlagen-test"));
});

async function insertSuggestion(params: { suggested_name: string; parent_slug: string | null }) {
  const [row] = await db
    .insert(documentCategorySuggestions)
    .values({
      suggested_name: params.suggested_name,
      parent_slug: params.parent_slug,
      status: "open",
    })
    .returning({ id: documentCategorySuggestions.id });
  return row!.id;
}

describe("acceptCategorySuggestion", () => {
  it("reuses an existing sibling category with the same name instead of creating a duplicate", async () => {
    // Existing category "Beruf" > "Betriebliche Unterlagen" (slug carries a
    // "beruf-" prefix, as the real taxonomy does).
    const [parent] = await db
      .insert(documentCategories)
      .values({ slug: "beruf-test-parent", name: "Beruf Test" })
      .returning({ id: documentCategories.id });
    await db.insert(documentCategories).values({
      slug: "beruf-betriebliche-unterlagen-test",
      name: "Betriebliche Unterlagen Test",
      parent_id: parent!.id,
    });

    // A suggestion with the identical name, whose auto-derived slug does NOT
    // collide with the existing row (mirrors slugify() dropping the "beruf-"
    // prefix) — this used to insert a second, duplicate-looking category.
    const suggestionId = await insertSuggestion({
      suggested_name: "Betriebliche Unterlagen Test",
      parent_slug: "beruf-test-parent",
    });

    const result = await acceptCategorySuggestion({ id: suggestionId });

    const siblings = await db
      .select()
      .from(documentCategories)
      .where(and(eq(documentCategories.parent_id, parent!.id)));

    expect(siblings).toHaveLength(1);
    expect(result.category_id).toBe(siblings[0]!.id);
    expect(siblings[0]!.slug).toBe("beruf-betriebliche-unterlagen-test");
  });

  it("still creates a new top-level category when no name collision exists", async () => {
    const suggestionId = await insertSuggestion({
      suggested_name: "Ganz Neue Kategorie Test",
      parent_slug: null,
    });

    const result = await acceptCategorySuggestion({ id: suggestionId });

    const [created] = await db
      .select()
      .from(documentCategories)
      .where(eq(documentCategories.id, result.category_id));

    expect(created).toBeDefined();
    expect(created!.name).toBe("Ganz Neue Kategorie Test");
    expect(created!.parent_id).toBeNull();

    await db.delete(documentCategories).where(eq(documentCategories.id, result.category_id));
  });
});
