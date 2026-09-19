/**
 * Which of the style's tables a region database has (§4.7).
 *
 * The question only exists because osm2pgsql applies a style on
 * `--create` and never migrates: a region imported before a table
 * joined the style does not have it, and the only honest way to know
 * is to ask the database rather than an import date.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  createSeededRegion,
  dropRegion,
  postgisAvailable,
  seedAdmin,
  seedRoutes,
} from "./test-db.ts";
import { regionTables, STYLE_TABLES } from "./import.ts";

/** A region as an older import left it: no osm_routes. */
const OLD = "geo_test_tables_old";
/** A region the current style built. */
const CURRENT = "geo_test_tables_current";

let available = false;

before(async () => {
  available = await postgisAvailable();
  if (!available) return;
  await createSeededRegion(OLD, []);
  await seedAdmin(OLD, []);

  await createSeededRegion(CURRENT, []);
  await seedAdmin(CURRENT, []);
  await seedRoutes(CURRENT, []);
});

after(async () => {
  if (!available) return;
  await dropRegion(OLD);
  await dropRegion(CURRENT);
});

// Neither fixture carries `osm_highways` — the seed helpers build the
// slice of a region these tests need, not a whole import — so the
// assertions below name `osm_routes`, which is the table the question
// is actually about.

test("names the table an older import lacks", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const tables = await regionTables(OLD);

  assert.ok(tables.missing.includes("osm_routes"), `missing was ${tables.missing}`);
  assert.ok(tables.present.includes("osm_pois"));
  assert.ok(tables.present.includes("osm_admin"));
});

test("does not name it for a region that has it", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const tables = await regionTables(CURRENT);

  assert.equal(tables.missing.includes("osm_routes"), false);
  assert.ok(tables.present.includes("osm_routes"));
});

test("reads a table that is simply absent as missing, not as an error", async (t) => {
  if (!available) return t.skip("no PostGIS available");
  const tables = await regionTables(CURRENT);

  assert.ok(tables.missing.includes("osm_highways"));
  assert.equal(tables.database, CURRENT);
  assert.equal(tables.present.length + tables.missing.length, STYLE_TABLES.length);
});
