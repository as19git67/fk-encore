import { test } from "node:test";
import assert from "node:assert/strict";
import { orphanedPbfs, pbfsForDatabase, postgresDbForPbf } from "./pbf-cache.ts";

const DAY = 24 * 60 * 60 * 1000;

test("a cached extract maps to the database its region got", () => {
  // slug "us/new-york" → file us_new-york.pbf; the app names the database
  // nom_us_new_york (osm-admin/region.service.ts slugToPostgresDb).
  assert.equal(postgresDbForPbf("us_new-york.pbf"), "nom_us_new_york");
  assert.equal(postgresDbForPbf("europe_germany_bayern.pbf"), "nom_europe_germany_bayern");
  assert.equal(postgresDbForPbf("oberbayern.pbf"), "nom_oberbayern");
  assert.equal(postgresDbForPbf("europe.pbf"), "nom_europe");
  assert.equal(postgresDbForPbf("europe.pbf.part"), null);
  assert.equal(postgresDbForPbf("readme.txt"), null);
});

test("orphans are files without a database, unless importing or fresh", () => {
  const now = 10 * DAY;
  const files = [
    { name: "europe.pbf", mtimeMs: 0 },
    { name: "oberbayern.pbf", mtimeMs: 0 },
    { name: "kanto.pbf", mtimeMs: 0 },
    { name: "fresh.pbf", mtimeMs: now - 1000 },
  ];
  const orphans = orphanedPbfs({
    files,
    liveDatabases: new Set(["nom_oberbayern"]),
    importing: new Set(["nom_kanto"]),
    now,
    minAgeMs: DAY,
  });
  assert.deepEqual(orphans, ["europe.pbf"]);
});

test("a region's own extract is found by its database name", () => {
  const files = [{ name: "us_new-york.pbf", mtimeMs: 0 }, { name: "europe.pbf", mtimeMs: 0 }];
  assert.deepEqual(pbfsForDatabase(files, "nom_us_new_york"), ["us_new-york.pbf"]);
  assert.deepEqual(pbfsForDatabase(files, "nom_berlin"), []);
});
