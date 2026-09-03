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
 * Two invariants, and the difference between them is the point:
 *
 *   - The photo matcher's filters must be a **subset** of what the
 *     import carries — not equal to it. Since the planner arrived, the
 *     import also brings gastronomy and everyday infrastructure, which
 *     the matcher must never see: it looks for what a photo could show,
 *     and a bakery among the candidates would push out a landmark.
 *   - A search category may only reference tags the import **does**
 *     carry. A category whose tags never reach the table returns
 *     nothing, silently, and nobody notices until a trip has no
 *     candidates.
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

  it("the photo matcher only asks for tags the import carries", () => {
    for (const filter of POI_TAG_FILTERS) {
      const imported = luaFilters[filter.key];
      expect(
        imported,
        `poi.config.ts filters on '${filter.key}', which osm2pgsql.lua never imports`,
      ).toBeDefined();

      if (filter.values === "*") {
        expect(
          imported,
          `poi.config.ts wants every '${filter.key}', so the import must be a wildcard too`,
        ).toBe("*");
        continue;
      }
      if (imported === "*") continue; // a wildcard import covers any value
      for (const value of filter.values) {
        expect(
          (imported as string[]).includes(value),
          `the matcher asks for '${filter.key}=${value}', which the import drops`,
        ).toBe(true);
      }
    }
  });

  it("the matcher does not see what only the planner needs", () => {
    // Deliberately asymmetric: the import is the larger set. If these
    // ever appear in the matcher's filters, photo POI detection starts
    // competing with bakeries — see poi-categories.ts.
    const plannerOnly = ["restaurant", "cafe", "pharmacy", "supermarket", "playground"];
    const matcherValues = new Set(
      POI_TAG_FILTERS.flatMap((f) => (f.values === "*" ? [] : [...f.values])),
    );
    for (const value of plannerOnly) {
      expect(matcherValues.has(value), `'${value}' must stay out of poi.config.ts`).toBe(false);
    }
  });

  it("geo's matcher defaults still spell out every value the matcher asks for", () => {
    // pois.ts carries the same narrow set as poi.config.ts, as the
    // defaults the photo matcher gets when it sends none. Checking the
    // values appear at all is enough to catch one being dropped.
    for (const filter of POI_TAG_FILTERS) {
      if (filter.values === "*") {
        expect(poisSource, `pois.ts should still handle ${filter.key}=*`).toContain("historicAny");
        continue;
      }
      for (const value of filter.values) {
        expect(poisSource, `pois.ts lost '${value}' from ${filter.key}`).toContain(`"${value}"`);
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
