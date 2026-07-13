import assert from "node:assert/strict";
import test from "node:test";
import {
  getUpdateStorageStatus,
  getReplicationStatus,
  type ReplicationStatusQuery,
} from "./replication.ts";

function scriptedQuery(responses: unknown[][]): {
  db: ReplicationStatusQuery;
  statements: string[];
} {
  const statements: string[] = [];
  let index = 0;
  return {
    statements,
    db: {
      async query<T>(text: string): Promise<{ rows: T[] }> {
        statements.push(text);
        return { rows: (responses[index++] ?? []) as T[] };
      },
    },
  };
}

test("reads Debian Bookworm / osm2pgsql 1.8 legacy replication state", async () => {
  const { db, statements } = scriptedQuery([
    [{ properties_table: null, legacy_table: "planet_osm_replication_status" }],
    [{ sequence: "4812", timestamp: "2026-07-04 09:00:00+00" }],
  ]);

  const status = await getReplicationStatus("nom_sachsen", db);

  assert.deepEqual(status, {
    postgresDb: "nom_sachsen",
    initialized: true,
    sequence: 4812,
    timestamp: "2026-07-04 09:00:00+00",
  });
  assert.match(statements[0]!, /planet_osm_replication_status/);
  assert.match(statements[1]!, /sequence, importdate::text AS timestamp/);
});

test("reads osm2pgsql >= 1.9 replication properties", async () => {
  const { db, statements } = scriptedQuery([
    [{ properties_table: "osm2pgsql_properties", legacy_table: null }],
    [
      { property: "replication_base_url", value: "https://example.test/updates/" },
      { property: "replication_sequence_number", value: "9001" },
      { property: "replication_timestamp", value: "2026-07-04T09:00:00Z" },
    ],
  ]);

  const status = await getReplicationStatus("nom_sachsen", db);

  assert.equal(status.initialized, true);
  assert.equal(status.sequence, 9001);
  assert.equal(status.timestamp, "2026-07-04T09:00:00Z");
  assert.match(statements[1]!, /FROM osm2pgsql_properties/);
});

test("a properties table without replication keys is not initialized", async () => {
  const { db } = scriptedQuery([
    [{ properties_table: "osm2pgsql_properties", legacy_table: null }],
    [{ property: "version", value: "1.9.0" }],
  ]);

  const status = await getReplicationStatus("nom_sachsen", db);

  assert.deepEqual(status, {
    postgresDb: "nom_sachsen",
    initialized: false,
    sequence: null,
    timestamp: null,
  });
});

test("falls back to legacy state when properties contain no replication keys", async () => {
  const { db } = scriptedQuery([
    [{
      properties_table: "osm2pgsql_properties",
      legacy_table: "planet_osm_replication_status",
    }],
    [],
    [{ sequence: 42, timestamp: null }],
  ]);

  const status = await getReplicationStatus("nom_sachsen", db);

  assert.equal(status.initialized, true);
  assert.equal(status.sequence, 42);
});

test("detects retained slim middle tables required for replication append", async () => {
  const { db, statements } = scriptedQuery([
    [{
      planet_osm_nodes: "planet_osm_nodes",
      planet_osm_ways: "planet_osm_ways",
      planet_osm_rels: "planet_osm_rels",
    }],
  ]);

  const status = await getUpdateStorageStatus("nom_sachsen", db);

  assert.deepEqual(status, { updatable: true, missingTables: [] });
  assert.match(statements[0]!, /planet_osm_nodes/);
});

test("reports missing osm2pgsql slim middle tables before append", async () => {
  const { db } = scriptedQuery([
    [{
      planet_osm_nodes: null,
      planet_osm_ways: "planet_osm_ways",
      planet_osm_rels: null,
    }],
  ]);

  const status = await getUpdateStorageStatus("nom_sachsen", db);

  assert.deepEqual(status, {
    updatable: false,
    missingTables: ["planet_osm_nodes", "planet_osm_rels"],
  });
});
