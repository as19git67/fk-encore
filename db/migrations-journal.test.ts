import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Drizzle runs a migration only when its journal timestamp (`when`) is newer
// than the last migration the database has applied. A migration whose
// timestamp is older than an earlier one is skipped on every database that
// already ran that earlier one — silently, while a fresh test database runs
// it. Each new entry must therefore be newer than every entry before it.

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const dir = path.join(process.cwd(), "db", "migrations", "postgres");
const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as {
  entries: JournalEntry[];
};

// Entries that broke the rule before this test existed: 0005 predates every
// deployed database, 0316 repeats 0313 and 0314.
const KNOWN_OUT_OF_ORDER = new Set([
  "0005_green_cammi",
  "0313_travel_hotel_area_flex",
  "0314_finance_depot_watch_from",
]);

describe("migration journal", () => {
  it("gives every migration a timestamp newer than all before it", () => {
    let newest = 0;
    const offenders: string[] = [];
    for (const e of journal.entries) {
      if (e.when <= newest && !KNOWN_OUT_OF_ORDER.has(e.tag)) offenders.push(`${e.tag} (${e.when} <= ${newest})`);
      newest = Math.max(newest, e.when);
    }
    expect(offenders).toEqual([]);
  });

  it("has a file for each entry", () => {
    const missing = journal.entries.filter((e) => !fs.existsSync(path.join(dir, `${e.tag}.sql`)));
    expect(missing.map((e) => e.tag)).toEqual([]);
  });
});
