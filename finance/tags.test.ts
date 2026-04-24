import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";

import db from "../db/database";
import { financeTag, financeTagTransaction } from "../db/schema";
import { listTags } from "./tags";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

beforeEach(async () => {
  await db.delete(financeTagTransaction);
  await db.delete(financeTag);
  setAuth("1", []);
});

async function insertTag(
  name: string,
  source: "user" | "ai" = "user",
): Promise<number> {
  const [row] = await db
    .insert(financeTag)
    .values({ name, source })
    .returning({ id: financeTag.id });
  return row.id;
}

describe("finance/tags — list", () => {
  it("defaults to source=user", async () => {
    setAuth("1", ["finance.view"]);
    await insertTag("urlaub", "user");
    await insertTag("urlaub", "ai");
    await insertTag("miete", "user");

    const { items } = await listTags({});
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.name).sort()).toEqual(["miete", "urlaub"]);
    expect(items.every((i) => i.source === "user")).toBe(true);
  });

  it("returns AI tags when source='ai'", async () => {
    setAuth("1", ["finance.view"]);
    await insertTag("urlaub", "user");
    await insertTag("restaurant", "ai");

    const { items } = await listTags({ source: "ai" });
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("restaurant");
  });

  it("returns both sources when source='all'", async () => {
    setAuth("1", ["finance.view"]);
    await insertTag("urlaub", "user");
    await insertTag("restaurant", "ai");

    const { items } = await listTags({ source: "all" });
    expect(items).toHaveLength(2);
  });

  it("orders alphabetically", async () => {
    setAuth("1", ["finance.view"]);
    await insertTag("zyx", "user");
    await insertTag("abc", "user");
    await insertTag("mno", "user");

    const { items } = await listTags({});
    expect(items.map((i) => i.name)).toEqual(["abc", "mno", "zyx"]);
  });

  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(listTags({})).rejects.toThrow(/permission/);
  });

  it("returns empty on unknown source", async () => {
    setAuth("1", ["finance.view"]);
    await insertTag("a", "user");
    const { items } = await listTags({ source: "bogus" as any });
    expect(items).toEqual([]);
  });
});
