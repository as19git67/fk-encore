import { Pool } from "pg";

const host = process.env.POSTGRES_HOST || "localhost";
const port = process.env.POSTGRES_PORT || "5432";
const user = process.env.POSTGRES_USER || "postgres";
const password = process.env.POSTGRES_PASSWORD || "postgres";
const testDb = process.env.POSTGRES_TEST_DB || "encore_test";

const adminConnString = `postgres://${user}:${password}@${host}:${port}/postgres`;

export async function setup() {
  const pool = new Pool({ connectionString: adminConnString });
  try {
    // Terminate any existing connections to the test DB (e.g. from a previous run)
    await pool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [testDb]);
    await pool.query(`DROP DATABASE IF EXISTS "${testDb}"`);
    await pool.query(`CREATE DATABASE "${testDb}"`);
    console.log(`[globalSetup] Created test database: ${testDb}`);
  } finally {
    await pool.end();
  }

  // Install the pgvector extension up-front. Migration 0027 does the same
  // via `CREATE EXTENSION IF NOT EXISTS vector`, but if the Postgres server
  // lacks the pgvector library that migration will hang in the reconnect
  // loop. Failing here with a clear message is much easier to diagnose.
  const testPool = new Pool({
    connectionString: `postgres://${user}:${password}@${host}:${port}/${testDb}`,
  });
  try {
    await testPool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (err: any) {
    throw new Error(
      `[globalSetup] Failed to enable pgvector on ${testDb}: ${err?.message ?? err}. ` +
      `The test database needs a Postgres server with pgvector installed — use the ` +
      `pgvector/pgvector:pg18 image (see docker-compose.test.yml).`,
    );
  } finally {
    await testPool.end();
  }
}

export async function teardown() {
  const pool = new Pool({ connectionString: adminConnString });
  try {
    await pool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [testDb]);
    await pool.query(`DROP DATABASE IF EXISTS "${testDb}"`);
    console.log(`[globalSetup] Dropped test database: ${testDb}`);
  } finally {
    await pool.end();
  }
}
