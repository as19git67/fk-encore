import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Plain JavaScript that runs in the image without a build step; loaded at
// run time so the TypeScript tooling never has to resolve it.
const { commitOf, describeResult, diffSchemas, newEntries, pendingEntries, safeError, unappliedEntries } = await import(
  "./schema.mjs" as string
);
const { loadDeps, newestDump, runCheck } = await import("./upgrade-check.mjs" as string);

/**
 * The upgrade check (documentation/plans/dev-system.md, stage 3). The pure
 * rules are tested on their own; runCheck runs against the test cluster on
 * tiny migration folders, among them the fault of PR #1919: a migration
 * whose journal timestamp is older than the newest one already applied, so
 * Drizzle skips it on every database with history.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("schema comparison", () => {
  it("names what is missing, extra or different on the copy, ignoring listed prefixes", () => {
    const fresh = new Map([
      ["relation:public.a", "table"],
      ["column:public.a.x", "integer"],
      ["column:public.a.y", "text"],
      ["index:public.a_idx", "CREATE INDEX a_idx ON public.a USING btree (x)"],
    ]);
    const copy = new Map([
      ["relation:public.a", "table"],
      ["column:public.a.x", "bigint"],
      ["relation:public.legacy", "table"],
      ["index:public.a_idx", "CREATE INDEX a_idx ON public.a USING btree (x)"],
    ]);
    expect(diffSchemas(copy, fresh)).toEqual([
      { kind: "changed", key: "column:public.a.x" },
      { kind: "missing", key: "column:public.a.y" },
      { kind: "extra", key: "relation:public.legacy" },
    ]);
    expect(diffSchemas(copy, fresh, ["relation:public.legacy", "column:public.a."])).toEqual([]);
  });

  it("finds journal entries the copy never applied, by timestamp or by file hash", () => {
    const journal = { entries: [{ tag: "0001_a", when: 1000 }, { tag: "0002_b", when: 3000 }, { tag: "0003_c", when: 2000 }] };
    const rows = [{ created_at: "1000", hash: "h1" }, { created_at: "3000", hash: "h2" }];
    expect(unappliedEntries(journal, rows).map((e: { tag: string }) => e.tag)).toEqual(["0003_c"]);
    expect(unappliedEntries(journal, [...rows, { created_at: "9", hash: "h3" }], new Map([["0003_c", "h3"]]))).toEqual([]);
    // Drizzle's rule: only entries younger than the newest row are applied.
    expect(pendingEntries(journal, 3000)).toEqual([]);
    expect(pendingEntries(journal, null)).toHaveLength(3);
  });

  it("counts as new only the entries after the last one the database recorded", () => {
    const journal = { entries: [{ tag: "0001_a", when: 1000 }, { tag: "0002_b", when: 500 }, { tag: "0003_c", when: 3000 }, { tag: "0004_d", when: 2000 }] };
    // 0002_b was skipped long ago and repaired by 0003_c: history, not new.
    const before = [{ created_at: "1000", hash: "h1" }, { created_at: "3000", hash: "h3" }];
    expect(newEntries(journal, before).map((e: { tag: string }) => e.tag)).toEqual(["0004_d"]);
    expect(newEntries(journal, [])).toHaveLength(4);
  });

  it("reads the commit from APP_BUILD_NUMBER", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(commitOf(`812-${sha}`)).toBe(sha);
    expect(commitOf("dev")).toBeNull();
    expect(commitOf(undefined)).toBeNull();
  });

  it("reports a Postgres error by code and object names, never by its message or detail", () => {
    const err = Object.assign(new Error('invalid input syntax for type integer: "secret"'), {
      code: "22P02",
      detail: "Key (email)=(someone@beispiel.test) already exists.",
      schema: "public",
      table: "users",
      column: "age",
    });
    const text = safeError(err);
    expect(text).toBe("22P02 public.users age");
    expect(describeResult({ state: "failure", failedMigration: "0316_x", error: text })).not.toMatch(/secret|beispiel/);
  });

  it("keeps every status text within GitHub's 140 characters", () => {
    const long = "x".repeat(300);
    for (const result of [
      { state: "failure", failedMigration: long, error: long },
      { state: "failure", unapplied: [long, "b"] },
      { state: "failure", differences: [{ kind: "missing", key: long }] },
      { state: "error", error: long },
      { state: "success", applied: 3 },
    ]) {
      expect(describeResult(result).length).toBeLessThanOrEqual(140);
    }
  });
});

describe("newestDump", () => {
  it("takes the newest nightly dump and nothing else", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "upgrade-dumps-"));
    for (const [name, age] of [
      ["encore-daily-2026-11-13_01-30.dump", 3],
      ["encore-daily-2026-11-14_01-30.dump", 2],
      ["pre-restore-2026-11-15.dump", 1],
    ] as const) {
      const file = path.join(dir, name);
      writeFileSync(file, "");
      const t = Date.now() / 1000 - age * 86400;
      utimesSync(file, t, t);
    }
    expect(path.basename(newestDump(dir))).toBe("encore-daily-2026-11-14_01-30.dump");
    expect(newestDump(path.join(dir, "missing"))).toBeNull();
  });
});

describe("runCheck", () => {
  const adminUrl = (() => {
    const u = new URL(process.env.POSTGRES_TEST_CONNECTION_STRING || "postgres://postgres:postgres@localhost:5432/encore_test");
    u.pathname = "/postgres";
    return u.toString();
  })();

  /** A migrations folder in Drizzle's layout, with explicit journal timestamps. */
  function folder(migrations: { tag: string; when: number; sql: string }[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "upgrade-migrations-"));
    mkdirSync(path.join(dir, "meta"));
    writeFileSync(
      path.join(dir, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: migrations.map((m, idx) => ({ idx, version: "7", when: m.when, tag: m.tag, breakpoints: true })),
      }),
    );
    for (const m of migrations) writeFileSync(path.join(dir, `${m.tag}.sql`), m.sql);
    return dir;
  }

  const base = [
    { tag: "0000_items", when: 1_000, sql: "CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL);" },
    { tag: "0001_price", when: 3_000, sql: "ALTER TABLE items ADD COLUMN price integer;" },
  ];
  const names = { copyDb: "encore_upgrade_check_t", freshDb: "encore_upgrade_fresh_t" };

  async function check(prodFolder: string, candidateFolder: string) {
    const deps = await loadDeps(root);
    return runCheck({
      deps,
      adminUrl,
      migrationsFolder: candidateFolder,
      // Prod's history: the migrations of an older image, and a row of data.
      restore: async (url: string) => {
        const client = new deps.Client({ connectionString: url });
        await client.connect();
        try {
          await deps.migrate(deps.drizzle(client), { migrationsFolder: prodFolder });
          await client.query("INSERT INTO items (name) VALUES ('Beispiel')");
        } finally {
          await client.end();
        }
      },
      ...names,
    });
  }

  it("passes when the copy reaches the schema of a fresh database", async () => {
    const result = await check(
      folder(base),
      folder([...base, { tag: "0002_stock", when: 4_000, sql: "ALTER TABLE items ADD COLUMN stock integer DEFAULT 0 NOT NULL;" }]),
    );
    expect(result).toMatchObject({ state: "success", applied: 1, unapplied: [], differences: [] });
  });

  it("fails on a migration that the journal's timestamps make Drizzle skip (#1919)", async () => {
    const result = await check(
      folder(base),
      folder([...base, { tag: "0002_watch_from", when: 2_000, sql: "ALTER TABLE items ADD COLUMN watch_from date;" }]),
    );
    expect(result.state).toBe("failure");
    expect(result.unapplied).toEqual(["0002_watch_from"]);
    expect(result.differences).toEqual([{ kind: "missing", key: "column:public.items.watch_from" }]);
    expect(describeResult(result)).toBe("skipped on the copy of prod: 0002_watch_from");
  });

  it("passes when prod never recorded an old skipped migration that a later one repaired (0314 and 0316)", async () => {
    const repair = { tag: "0003_repair", when: 5_000, sql: "-- repeats 0002\nALTER TABLE items ADD COLUMN IF NOT EXISTS watch_from date;" };
    // Prod's history: 0002 never ran (skipped), 0003 repaired it.
    const prod = folder([...base, repair]);
    const candidate = folder([
      ...base,
      { tag: "0002_watch_from", when: 2_000, sql: "ALTER TABLE items ADD COLUMN watch_from date;" },
      repair,
    ]);
    const result = await check(prod, candidate);
    expect(result).toMatchObject({ state: "success", applied: 0, unapplied: [], differences: [] });
  });

  it("fails on a migration that prod's rows break, naming it and the error code only", async () => {
    const result = await check(
      folder(base),
      folder([...base, { tag: "0002_sku", when: 4_000, sql: "ALTER TABLE items ADD COLUMN sku text NOT NULL;" }]),
    );
    expect(result).toMatchObject({ state: "failure", failedMigration: "0002_sku" });
    expect(result.error).toMatch(/^23502\b/);
    expect(describeResult(result)).not.toContain("Beispiel");
  });

  it("drops its scratch databases afterwards and never touches another one", async () => {
    const deps = await loadDeps(root);
    const admin = new deps.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'encore_upgrade_%'");
      expect(rows).toEqual([]);
    } finally {
      await admin.end();
    }
    await expect(
      runCheck({ deps, adminUrl, migrationsFolder: folder(base), restore: async () => {}, copyDb: "encore", freshDb: "encore_upgrade_fresh_t" }),
    ).rejects.toThrow(/refusing to touch database encore/);
  });
});
