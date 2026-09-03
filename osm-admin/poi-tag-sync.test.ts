/**
 * Guards the OSM tag knowledge that lives in four places at once.
 *
 * The same facts — which tags reach `osm_pois`, which of them count as
 * POI candidates, and which categories the planning search offers —
 * are written down in:
 *
 *   1. `geo/src/osm2pgsql.lua`      — the import filter and tag allowlist
 *   2. `osm-admin/poi.config.ts`    — the filters the photo matcher sends
 *   3. `geo/src/pois.ts`            — the query defaults on the geo side
 *   4. `geo/src/poi-categories.ts`  — the categories `/pois/search` offers
 *
 * They cannot import from one another: geo is a standalone package
 * shipped in its own container, so a shared module would have to be
 * published or vendored. Until that happens, two comments saying "must
 * stay in sync" are the only thing holding them together — which is
 * exactly the kind of promise that quietly breaks.
 *
 * This test reads the files from disk and compares them. It runs in the
 * main suite (geo's own tests are excluded from it), so drift fails a
 * normal `npm run test` rather than surfacing as an empty result set in
 * production.
 *
 * The invariant that matters most is the last one: **a search category
 * may only reference tags the import actually carries.** A category
 * whose tags never reach the table returns nothing, silently.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { POI_TAG_FILTERS } from "./poi.config";

const repoRoot = path.resolve(__dirname, "..");
const luaSource = readFileSync(path.join(repoRoot, "geo/src/osm2pgsql.lua"), "utf8");
const poisSource = readFileSync(path.join(repoRoot, "geo/src/pois.ts"), "utf8");
const categoriesSource = readFileSync(path.join(repoRoot, "geo/src/poi-categories.ts"), "utf8");

/** Extract a `local <name> = { ... }` table body from the Lua source. */
function luaTableBody(name: string): string {
  const start = luaSource.indexOf(`local ${name} = {`);
  expect(start, `Lua table '${name}' not found — did it get renamed?`).toBeGreaterThan(-1);
  const open = luaSource.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < luaSource.length; i += 1) {
    if (luaSource[i] === "{") depth += 1;
    if (luaSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return luaSource.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated Lua table '${name}'`);
}

/** `poi_filters` → { tourism: ["attraction", …], historic: "*" }. */
function parseLuaPoiFilters(): Record<string, string[] | "*"> {
  const body = luaTableBody("poi_filters");
  const out: Record<string, string[] | "*"> = {};
  const entry = /(\w+)\s*=\s*(?:'(\*)'|\{([^}]*)\})/g;
  for (const match of body.matchAll(entry)) {
    const [, key, star, inner] = match;
    if (star) {
      out[key] = "*";
      continue;
    }
    out[key] = [...(inner ?? "").matchAll(/(\w+)\s*=\s*true/g)].map((m) => m[1]);
  }
  return out;
}

/** `poi_tag_allowlist` → the set of tag keys kept in the jsonb column. */
function parseLuaAllowlist(): Set<string> {
  const body = luaTableBody("poi_tag_allowlist");
  const keys = [...body.matchAll(/\[?'([\w:]+)'\]?\s*=\s*true/g)].map((m) => m[1]);
  return new Set(keys);
}

/** Tag keys the search categories rely on. */
function parseCategoryKeys(): Set<string> {
  return new Set([...categoriesSource.matchAll(/\{\s*key:\s*"([\w:]+)"/g)].map((m) => m[1]));
}

/** Values a category constrains a key to, per key. */
function parseCategoryValuesByKey(): Map<string, Set<string>> {
  const byKey = new Map<string, Set<string>>();
  const rule = /\{\s*key:\s*"([\w:]+)"(?:\s*,\s*values:\s*\[([^\]]*)\])?\s*\}/g;
  for (const match of categoriesSource.matchAll(rule)) {
    const [, key, values] = match;
    const set = byKey.get(key) ?? new Set<string>();
    for (const value of (values ?? "").matchAll(/"([\w:-]+)"/g)) set.add(value[1]);
    byKey.set(key, set);
  }
  return byKey;
}

describe("OSM tag knowledge stays in sync across packages", () => {
  const luaFilters = parseLuaPoiFilters();

  it("the Lua import filter matches osm-admin's POI_TAG_FILTERS", () => {
    const configured: Record<string, string[] | "*"> = {};
    for (const filter of POI_TAG_FILTERS) {
      configured[filter.key] = filter.values === "*" ? "*" : [...filter.values];
    }

    expect(Object.keys(luaFilters).sort()).toEqual(Object.keys(configured).sort());
    for (const [key, values] of Object.entries(configured)) {
      const lua = luaFilters[key];
      if (values === "*") {
        expect(lua, `${key} should be a wildcard in the Lua filter`).toBe("*");
        continue;
      }
      expect(lua, `${key} should be a value list in the Lua filter`).not.toBe("*");
      expect([...(lua as string[])].sort()).toEqual([...values].sort());
    }
  });

  it("geo's query defaults cover the same tags the import keeps", () => {
    // pois.ts spells its defaults out as a literal; checking the values
    // appear at all is enough to catch a key being dropped on one side.
    for (const [key, values] of Object.entries(luaFilters)) {
      if (values === "*") {
        expect(poisSource, `pois.ts should still handle ${key}=*`).toContain("historicAny");
        continue;
      }
      for (const value of values) {
        expect(poisSource, `pois.ts lost '${value}' from ${key}`).toContain(`"${value}"`);
      }
    }
  });

  it("every tag key a search category uses survives the import", () => {
    const allowlist = parseLuaAllowlist();
    for (const key of parseCategoryKeys()) {
      expect(
        allowlist.has(key),
        `poi-categories.ts filters on '${key}', but osm2pgsql.lua does not keep it in ` +
          `poi_tag_allowlist — the category would silently match nothing`,
      ).toBe(true);
    }
  });

  it("every tag value a search category expects is actually imported", () => {
    for (const [key, values] of parseCategoryValuesByKey()) {
      const imported = luaFilters[key];
      expect(imported, `poi-categories.ts filters on '${key}', which the import ignores`).toBeDefined();
      if (imported === "*") continue;
      for (const value of values) {
        expect(
          (imported as string[]).includes(value),
          `category value '${key}=${value}' is never imported — add it to poi_filters ` +
            `in osm2pgsql.lua (and re-import) or drop it from the category`,
        ).toBe(true);
      }
    }
  });
});
