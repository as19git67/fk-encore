// The built-in sender rules move from the source tree into
// document_sender_rule_overrides (migration 0274). The seed copies them once;
// a rule the household deletes in the table afterwards must stay deleted.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { asc, eq, like } from "drizzle-orm";
import db from "./database";
import { documentSenderRuleImports, documentSenderRuleOverrides } from "./schema";
import { BUILT_IN_SENDER_RULES_IMPORT, importBuiltInSenderRules } from "./seed-sender-rules";
import type { SenderRule } from "../documents/sender-rules";

const RULES: SenderRule[] = [
  {
    note: "Beispielbank Auszug",
    senders: ["seedtestbeispielbank", "seedtestmusterbank"],
    requireAny: ["kontoauszug"],
    category: "finanzen-kontoauszuege",
  },
  {
    note: "Beispielversicherung",
    senders: ["seedtestbeispielversicherung"],
    excludeAny: ["kfz"],
    category: "versicherungen-sach",
  },
];

async function clean() {
  await db.delete(documentSenderRuleOverrides).where(like(documentSenderRuleOverrides.sender_pattern, "seedtest%"));
  await db.delete(documentSenderRuleImports).where(eq(documentSenderRuleImports.key, BUILT_IN_SENDER_RULES_IMPORT));
}

async function importedRows() {
  return db
    .select()
    .from(documentSenderRuleOverrides)
    .where(like(documentSenderRuleOverrides.sender_pattern, "seedtest%"))
    .orderBy(asc(documentSenderRuleOverrides.sort_order), asc(documentSenderRuleOverrides.id));
}

beforeEach(clean);
afterEach(clean);

describe("importBuiltInSenderRules", () => {
  it("writes one row per sender fragment, in rule order, after the household's own rules", async () => {
    expect(await importBuiltInSenderRules(db, RULES)).toBe(3);
    const rows = await importedRows();
    expect(rows.map((r) => r.sender_pattern)).toEqual([
      "seedtestbeispielbank",
      "seedtestmusterbank",
      "seedtestbeispielversicherung",
    ]);
    expect(rows[0]).toMatchObject({
      note: "Beispielbank Auszug",
      require_any: ["kontoauszug"],
      exclude_any: null,
      category: "finanzen-kontoauszuege",
    });
    expect(rows[2]).toMatchObject({ require_any: null, exclude_any: ["kfz"], category: "versicherungen-sach" });
    expect(rows[0].sort_order).toBe(rows[1].sort_order);
    expect(rows[2].sort_order).toBeGreaterThan(rows[0].sort_order);
    expect(rows[0].sort_order).toBeGreaterThan(0);
  });

  it("runs once: a rule deleted afterwards is not brought back", async () => {
    await importBuiltInSenderRules(db, RULES);
    await db.delete(documentSenderRuleOverrides).where(eq(documentSenderRuleOverrides.sender_pattern, "seedtestmusterbank"));
    expect(await importBuiltInSenderRules(db, RULES)).toBe(0);
    expect((await importedRows()).map((r) => r.sender_pattern)).not.toContain("seedtestmusterbank");
    const marker = await db.select().from(documentSenderRuleImports).where(eq(documentSenderRuleImports.key, BUILT_IN_SENDER_RULES_IMPORT));
    expect(marker[0]?.rule_count).toBe(3);
  });
});
