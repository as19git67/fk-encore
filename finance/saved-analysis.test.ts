import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

import db from "../db/database";
import { financeSavedAnalysis, users } from "../db/schema";
import { list, save, update, remove, markSeen } from "./saved-analysis";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.delete(financeSavedAnalysis);
  await db.delete(users);
  await ensureUser(1);
  await ensureUser(2);
  setAuth("1", ["finance.view"]);
});

describe("finance/saved-analysis — save", () => {
  it("creates a saved analysis", async () => {
    const item = await save({
      name: "Italien-Urlaub 2024",
      question: "Was hat der Urlaub gekostet?",
      ast: { tags: ["urlaub", "italien-2024"], op: "AND", kind: "event" },
      summary: { sum: "-429.50", count: 2, avg: "-214.75" },
    });

    expect(item.id).toBeGreaterThan(0);
    expect(item.name).toBe("Italien-Urlaub 2024");
    expect(item.question).toBe("Was hat der Urlaub gekostet?");
    expect(item.ast.tags).toEqual(["urlaub", "italien-2024"]);
    expect(item.source).toBe("user");
    expect(item.summary).toMatchObject({ sum: "-429.50", count: 2 });
  });

  it("rejects empty name", async () => {
    await expect(
      save({ name: "  ", ast: { tags: [], op: "AND" } }),
    ).rejects.toThrow(/non-empty/);
  });

  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(
      save({ name: "test", ast: { tags: [], op: "AND" } }),
    ).rejects.toThrow(/permission/);
  });
});

describe("finance/saved-analysis — list", () => {
  it("lists saved analyses for the current user, newest first", async () => {
    setAuth("1", ["finance.view"]);
    await save({ name: "A", ast: { tags: ["a"], op: "AND" } });
    await save({ name: "B", ast: { tags: ["b"], op: "OR" } });

    const { items, hasMore } = await list({});
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe("B");
    expect(items[1].name).toBe("A");
    expect(hasMore).toBe(false);
  });

  it("does not show other users' items", async () => {
    setAuth("1", ["finance.view"]);
    await save({ name: "Mine", ast: { tags: [], op: "AND" } });

    setAuth("2", ["finance.view"]);
    await save({ name: "Theirs", ast: { tags: [], op: "AND" } });

    setAuth("1", ["finance.view"]);
    const { items } = await list({});
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Mine");
  });

  it("paginates with before cursor", async () => {
    setAuth("1", ["finance.view"]);
    await save({ name: "First", ast: { tags: [], op: "AND" } });
    const second = await save({ name: "Second", ast: { tags: [], op: "AND" } });

    const { items } = await list({ limit: 1 });
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Second");

    const page2 = await list({ limit: 10, before: items[0].createdAt });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].name).toBe("First");
  });

  it("filters by source", async () => {
    setAuth("1", ["finance.view"]);
    await save({ name: "User Q", ast: { tags: [], op: "AND" } });
    // Simulate AI item
    await db.insert(financeSavedAnalysis).values({
      user_id: 1,
      name: "AI Insight",
      ast: { tags: ["transport"], op: "AND" },
      source: "ai",
      fingerprint: "fp-1",
    });

    const userOnly = await list({ source: "user" });
    expect(userOnly.items).toHaveLength(1);
    expect(userOnly.items[0].name).toBe("User Q");

    const aiOnly = await list({ source: "ai" });
    expect(aiOnly.items).toHaveLength(1);
    expect(aiOnly.items[0].name).toBe("AI Insight");
  });
});

describe("finance/saved-analysis — update", () => {
  it("updates name and summary", async () => {
    const item = await save({ name: "Old", ast: { tags: [], op: "AND" } });

    const updated = await update({
      id: item.id,
      name: "New Name",
      summary: { sum: "-100", count: 5, avg: "-20" },
    });

    expect(updated.name).toBe("New Name");
    expect(updated.summary).toMatchObject({ sum: "-100", count: 5 });
  });

  it("cannot update another user's item", async () => {
    const item = await save({ name: "Mine", ast: { tags: [], op: "AND" } });

    setAuth("2", ["finance.view"]);
    await expect(update({ id: item.id, name: "Stolen" })).rejects.toThrow(/not found/);
  });
});

describe("finance/saved-analysis — delete", () => {
  it("deletes an item", async () => {
    const item = await save({ name: "To Delete", ast: { tags: [], op: "AND" } });
    await remove({ id: item.id });

    const { items } = await list({});
    expect(items).toHaveLength(0);
  });

  it("cannot delete another user's item", async () => {
    const item = await save({ name: "Mine", ast: { tags: [], op: "AND" } });
    setAuth("2", ["finance.view"]);
    await expect(remove({ id: item.id })).rejects.toThrow(/not found/);
  });
});

describe("finance/saved-analysis — markSeen", () => {
  it("marks AI items as seen", async () => {
    await db.insert(financeSavedAnalysis).values({
      user_id: 1,
      name: "AI Insight",
      ast: { tags: ["x"], op: "AND" },
      source: "ai",
      fingerprint: "fp-seen",
    });

    const before = await list({ source: "ai" });
    expect(before.items[0].seenAt).toBeNull();

    await markSeen({ ids: [before.items[0].id] });

    const after = await list({ source: "ai" });
    expect(after.items[0].seenAt).not.toBeNull();
  });

  it("only marks own items", async () => {
    await db.insert(financeSavedAnalysis).values({
      user_id: 2,
      name: "Other user",
      ast: { tags: [], op: "AND" },
      source: "ai",
      fingerprint: "fp-other",
    });

    setAuth("2", ["finance.view"]);
    const { items } = await list({ source: "ai" });
    const id = items[0].id;

    setAuth("1", ["finance.view"]);
    await markSeen({ ids: [id] });

    setAuth("2", ["finance.view"]);
    const after = await list({ source: "ai" });
    expect(after.items[0].seenAt).toBeNull();
  });
});
