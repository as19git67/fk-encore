#!/usr/bin/env node
/**
 * The upgrade check (documentation/plans/dev-system.md, "The upgrade
 * check"): does the candidate image's set of migrations bring a database
 * with prod's history to the same schema as an empty one?
 *
 *   1. restore the newest nightly dump of prod (`encore-daily-*.dump`,
 *      prod's backup directory mounted read-only) into a scratch database
 *      `encore_upgrade_check` on the dev stack's postgres
 *   2. run the image's migrations on it with Drizzle's own migrator, exactly
 *      as the app's boot does (db/database.ts)
 *   3. run the same migrations on an empty database `encore_upgrade_fresh`
 *   4. compare: every journal entry applied on the copy, and the two schemas
 *      equal object by object (scripts/upgrade-check/schema.mjs)
 *   5. drop both databases
 *   6. report the result for the image's commit to GitHub as the commit
 *      status `prod-data/upgrade-check` — object names, migration tags and
 *      Postgres error codes only, never a row or a value
 *
 * It runs in the app image with the image's `node` (docker-compose.test.yml,
 * service `upgrade_check`) and finds the app's `pg`, `drizzle-orm` and
 * `db/migrations/postgres` in the working directory of the image — the same
 * ones the boot uses.
 *
 *   node upgrade-check.mjs [--stay] [--no-report]
 *
 *   --stay       keep the process alive after the check, so the container
 *                stays up until Watchtower replaces it with the next
 *                candidate (a restart of the same container does not check
 *                the same commit twice)
 *   --no-report  check without writing a status to GitHub (by hand)
 *
 * Exit codes: 0 passed, 1 failed, 2 could not run.
 *
 * The seed that the boot runs after the migrations (db/seed.ts) is
 * TypeScript compiled into the app bundle and is not run here; it only
 * inserts roles and permissions with ON CONFLICT and shows its errors at
 * the dev stack's next boot.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  commitOf,
  describeResult,
  describeSchema,
  diffSchemas,
  pendingEntries,
  safeError,
  unappliedEntries,
} from "./schema.mjs";

export const STATUS_CONTEXT = "prod-data/upgrade-check";
export const COPY_DB = "encore_upgrade_check";
export const FRESH_DB = "encore_upgrade_fresh";
const SCRATCH_PREFIX = "encore_upgrade_";

/** Loads the app's own `pg` and Drizzle from `appDir`, not from next to this file. */
export async function loadDeps(appDir = process.cwd()) {
  const require = createRequire(path.join(appDir, "package.json"));
  const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
  const pg = await load("pg");
  const nodePostgres = await load("drizzle-orm/node-postgres");
  const migrator = await load("drizzle-orm/node-postgres/migrator");
  const files = await load("drizzle-orm/migrator");
  return {
    Client: (pg.default ?? pg).Client,
    drizzle: nodePostgres.drizzle ?? nodePostgres.default?.drizzle,
    migrate: migrator.migrate ?? migrator.default?.migrate,
    readMigrationFiles: files.readMigrationFiles ?? files.default?.readMigrationFiles,
  };
}

function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function assertScratch(name) {
  if (!name.startsWith(SCRATCH_PREFIX) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to touch database ${name}: not a scratch database of the check`);
  }
}

async function recreate(deps, adminUrl, names) {
  const admin = new deps.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const name of names) {
      assertScratch(name);
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    }
  } finally {
    await admin.end();
  }
}

async function drop(deps, adminUrl, names) {
  const admin = new deps.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const name of names) {
      assertScratch(name);
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}

async function migrationRows(client) {
  const exists = await client.query(`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`);
  if (!exists.rows[0]?.t) return [];
  const { rows } = await client.query(`SELECT hash, created_at FROM drizzle.__drizzle_migrations`);
  return rows;
}

async function withClient(deps, url, fn) {
  const client = new deps.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function runMigrator(deps, url, migrationsFolder) {
  await withClient(deps, url, async (client) => {
    await deps.migrate(deps.drizzle(client), { migrationsFolder });
  });
}

/**
 * After the migrator failed (and rolled everything back), applies the
 * pending migrations one by one to find the one that fails. Only on the
 * scratch database.
 */
async function findFailing(deps, url, migrations, pending) {
  return withClient(deps, url, async (client) => {
    for (const entry of pending) {
      const migration = migrations.find((m) => m.tag === entry.tag);
      try {
        await client.query("BEGIN");
        for (const stmt of migration.sql) {
          if (stmt.trim()) await client.query(stmt);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        return { tag: entry.tag, err };
      }
    }
    return null;
  });
}

/**
 * Steps 1–5. `restore(url)` fills the copy (pg_restore of the dump in the
 * container, a few migrations in the tests). Returns the result that
 * describeResult() turns into the status text.
 */
export async function runCheck({
  deps,
  adminUrl,
  migrationsFolder,
  restore,
  copyDb = COPY_DB,
  freshDb = FRESH_DB,
  ignore = [],
  log = () => {},
}) {
  const copyUrl = withDatabase(adminUrl, copyDb);
  const freshUrl = withDatabase(adminUrl, freshDb);
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  const migrations = deps
    .readMigrationFiles({ migrationsFolder })
    .map((m, i) => ({ ...m, tag: journal.entries[i].tag }));
  const hashes = new Map(migrations.map((m) => [m.tag, m.hash]));

  await recreate(deps, adminUrl, [copyDb, freshDb]);
  try {
    log(`restoring the copy into ${copyDb}`);
    await restore(copyUrl);

    const before = await withClient(deps, copyUrl, migrationRows);
    const last = before.length ? Math.max(...before.map((r) => Number(r.created_at))) : null;
    const pending = pendingEntries(journal, last);
    log(`copy has ${before.length} migration(s); the migrator will apply ${pending.length}`);

    try {
      await runMigrator(deps, copyUrl, migrationsFolder);
    } catch (err) {
      log(`migrator failed on the copy: ${err?.message ?? err}`);
      const failing = await findFailing(deps, copyUrl, migrations, pending);
      return {
        state: "failure",
        applied: 0,
        failedMigration: failing?.tag ?? pending[0]?.tag ?? "(unknown migration)",
        error: safeError(failing?.err ?? err.cause ?? err),
      };
    }

    try {
      await runMigrator(deps, freshUrl, migrationsFolder);
    } catch (err) {
      return { state: "failure", applied: pending.length, failedMigration: "fresh database", error: safeError(err.cause ?? err) };
    }

    const after = await withClient(deps, copyUrl, migrationRows);
    const unapplied = unappliedEntries(journal, after, hashes).map((e) => e.tag);
    const copySchema = await withClient(deps, copyUrl, describeSchema);
    const freshSchema = await withClient(deps, freshUrl, describeSchema);
    const differences = diffSchemas(copySchema, freshSchema, ignore);
    for (const d of differences) log(`difference: ${d.kind} ${d.key}`);
    for (const tag of unapplied) log(`not applied on the copy: ${tag}`);

    const failed = unapplied.length > 0 || differences.length > 0;
    return { state: failed ? "failure" : "success", applied: pending.length, unapplied, differences };
  } finally {
    await drop(deps, adminUrl, [copyDb, freshDb]).catch((err) => log(`could not drop the scratch databases: ${err?.message ?? err}`));
  }
}

/** The newest `encore-daily-*.dump` in `dir`, by modification time. */
export function newestDump(dir) {
  if (!existsSync(dir)) return null;
  const dumps = readdirSync(dir)
    .filter((f) => /^encore-daily-.*\.dump$/.test(f))
    .map((f) => ({ file: path.join(dir, f), mtime: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return dumps[0]?.file ?? null;
}

function pgRestore(file, url) {
  const u = new URL(url);
  const env = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pg_restore",
      ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", env.PGDATABASE, file],
      { env, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_restore exited with ${code}`))));
  });
}

async function report({ repo, token, sha, result, log }) {
  const state = result.state === "success" || result.state === "failure" || result.state === "pending" ? result.state : "error";
  const res = await fetch(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "fk-encore-upgrade-check",
    },
    body: JSON.stringify({ state, context: STATUS_CONTEXT, description: describeResult(result) }),
  });
  if (!res.ok) log(`GitHub refused the status (${res.status})`);
}

function adminUrlFromEnv(env) {
  const user = encodeURIComponent(env.POSTGRES_USER || "postgres");
  const password = encodeURIComponent(env.POSTGRES_PASSWORD || "postgres");
  return `postgres://${user}:${password}@${env.POSTGRES_HOST || "postgres"}:${env.POSTGRES_PORT || "5432"}/postgres`;
}

async function main(argv, env) {
  const stay = argv.includes("--stay");
  const reportOn = !argv.includes("--no-report");
  const log = (msg) => console.log(`[upgrade-check ${new Date().toISOString()}] ${msg}`);
  const sha = commitOf(env.APP_BUILD_NUMBER);
  const repo = env.UPGRADE_CHECK_REPOSITORY || "as19git67/fk-encore";
  const token = env.UPGRADE_CHECK_GITHUB_TOKEN || "";
  const marker = sha ? `/tmp/upgrade-check-${sha}.done` : null;

  const idle = () => {
    if (!stay) return;
    log("done; waiting for the next candidate");
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1 << 30);
  };

  if (stay && marker && existsSync(marker)) {
    log(`commit ${sha} was checked before this restart`);
    return idle();
  }

  const send = async (result) => {
    if (!reportOn) return;
    if (!sha || !token) {
      log(`not reporting: ${!sha ? "no commit in APP_BUILD_NUMBER" : "UPGRADE_CHECK_GITHUB_TOKEN is empty"}`);
      return;
    }
    await report({ repo, token, sha, result, log }).catch((err) => log(`could not report: ${err?.message ?? err}`));
  };

  log(`checking ${sha ?? "an image without a commit"}`);
  await send({ state: "pending" });

  let result;
  try {
    const dumpDir = env.UPGRADE_CHECK_DUMP_DIR || "/mnt/prod-backup";
    const dump = newestDump(dumpDir);
    if (!dump) throw new Error(`no encore-daily-*.dump in ${dumpDir}`);
    log(`copy of prod: ${path.basename(dump)}`);
    const appDir = env.UPGRADE_CHECK_APP_DIR || process.cwd();
    result = await runCheck({
      deps: await loadDeps(appDir),
      adminUrl: adminUrlFromEnv(env),
      migrationsFolder: path.join(appDir, "db", "migrations", "postgres"),
      restore: (url) => pgRestore(dump, url),
      ignore: (env.UPGRADE_CHECK_IGNORE || "").split(",").map((s) => s.trim()).filter(Boolean),
      log,
    });
  } catch (err) {
    log(`could not run: ${err?.stack ?? err}`);
    result = { state: "error", error: err?.code ? safeError(err) : "see the container log" };
  }

  log(`${result.state}: ${describeResult(result)}`);
  await send(result);
  if (marker) writeFileSync(marker, result.state);
  process.exitCode = result.state === "success" ? 0 : result.state === "failure" ? 1 : 2;
  idle();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2), process.env);
}
