/**
 * The pure parts of the upgrade check (documentation/plans/dev-system.md,
 * "The upgrade check"): what the schema of a database is, how two of them
 * differ, which migrations of the journal a database is missing, and what
 * the commit status says.
 *
 * Plain JavaScript on purpose: the check runs in the app image with the
 * image's own `node`, next to the compiled app, and has no build step.
 *
 * Nothing here ever reads a row of a user table. The description of the
 * schema holds only object names and their definitions, and the status
 * text holds only object names, migration tags and Postgres error codes.
 */

/** Schemas that belong to Postgres or to the migrator, not to the app. */
export const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast", "drizzle"];

/** GitHub cuts a status description at 140 characters. */
export const DESCRIPTION_MAX = 140;

const schemaFilter = (alias) =>
  `${alias} NOT IN (${SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(", ")}) AND ${alias} NOT LIKE 'pg_temp_%' AND ${alias} NOT LIKE 'pg_toast_temp_%'`;

/**
 * One query per kind of object, each returning `key` and `def`. The key
 * names the object; the def is what has to be equal in both databases.
 * Extensions are compared by name only: an extension created a year ago
 * keeps its old version until someone runs ALTER EXTENSION … UPDATE, which
 * is no fault of the migrations.
 */
export const CATALOG_QUERIES = {
  schema: `
    SELECT 'schema:' || nspname AS key, '' AS def
    FROM pg_namespace n
    WHERE ${schemaFilter("nspname")}`,
  extension: `
    SELECT 'extension:' || extname AS key, '' AS def FROM pg_extension`,
  relation: `
    SELECT 'relation:' || n.nspname || '.' || c.relname AS key,
           CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table'
                          WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                          WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign table'
                          ELSE c.relkind::text END AS def
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${schemaFilter("n.nspname")}
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = c.oid AND d.deptype = 'e')`,
  column: `
    SELECT 'column:' || n.nspname || '.' || c.relname || '.' || a.attname AS key,
           format_type(a.atttypid, a.atttypmod)
             || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
             || COALESCE(' default ' || pg_get_expr(ad.adbin, ad.adrelid), '')
             || CASE a.attidentity WHEN 'a' THEN ' identity always' WHEN 'd' THEN ' identity by default' ELSE '' END
             || CASE a.attgenerated WHEN 's' THEN ' generated' ELSE '' END AS def
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attnum > 0 AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${schemaFilter("n.nspname")}
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = c.oid AND d.deptype = 'e')`,
  constraint: `
    SELECT 'constraint:' || n.nspname || '.' || c.relname || '.' || co.conname AS key,
           pg_get_constraintdef(co.oid) AS def
    FROM pg_constraint co
    JOIN pg_class c ON c.oid = co.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${schemaFilter("n.nspname")}
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = c.oid AND d.deptype = 'e')`,
  index: `
    SELECT 'index:' || n.nspname || '.' || ic.relname AS key,
           pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    WHERE ${schemaFilter("n.nspname")}
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = c.oid AND d.deptype = 'e')`,
  enum: `
    SELECT 'enum:' || n.nspname || '.' || t.typname AS key,
           string_agg(e.enumlabel, ',' ORDER BY e.enumlabel) AS def
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE ${schemaFilter("n.nspname")}
    GROUP BY n.nspname, t.typname`,
  view: `
    SELECT 'view:' || n.nspname || '.' || c.relname AS key,
           md5(pg_get_viewdef(c.oid)) AS def
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm') AND ${schemaFilter("n.nspname")}
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = c.oid AND d.deptype = 'e')`,
  function: `
    SELECT 'function:' || n.nspname || '.' || p.proname
             || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS key,
           md5(pg_get_functiondef(p.oid)) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p') AND ${schemaFilter("n.nspname")}
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = p.oid AND d.deptype = 'e')`,
  trigger: `
    SELECT 'trigger:' || n.nspname || '.' || c.relname || '.' || t.tgname AS key,
           pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND ${schemaFilter("n.nspname")}`,
};

/**
 * Reads the schema of the database behind `client` (a pg Client or Pool)
 * as a map from object key to definition.
 */
export async function describeSchema(client) {
  const schema = new Map();
  for (const query of Object.values(CATALOG_QUERIES)) {
    const { rows } = await client.query(query);
    for (const row of rows) schema.set(row.key, row.def ?? "");
  }
  return schema;
}

/** True when `key` falls under one of the ignored prefixes. */
export function ignored(key, ignore) {
  return ignore.some((prefix) => prefix && (key === prefix || key.startsWith(prefix)));
}

/**
 * Differences between the copy of prod after the candidate's migrations and
 * a fresh database with the same migrations, sorted by key. `missing` is in
 * the fresh database only (a skipped migration), `extra` in the copy only
 * (an object the migrations no longer create), `changed` in both with
 * another definition.
 */
export function diffSchemas(copy, fresh, ignore = []) {
  const out = [];
  for (const [key, def] of fresh) {
    if (ignored(key, ignore)) continue;
    if (!copy.has(key)) out.push({ kind: "missing", key });
    else if (copy.get(key) !== def) out.push({ kind: "changed", key });
  }
  for (const key of copy.keys()) {
    if (ignored(key, ignore)) continue;
    if (!fresh.has(key)) out.push({ kind: "extra", key });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.kind.localeCompare(b.kind));
}

/**
 * Journal entries the database has not applied. Drizzle records each
 * migration as a row with the journal's `when` as `created_at` and the
 * sha256 of the file as `hash`; an entry counts as applied when either
 * matches, so an old migration file edited after the fact is not reported.
 */
export function unappliedEntries(journal, rows, hashes = new Map()) {
  const when = new Set(rows.map((r) => Number(r.created_at)));
  const hash = new Set(rows.map((r) => r.hash));
  return journal.entries.filter((e) => !when.has(Number(e.when)) && !hash.has(hashes.get(e.tag)));
}

/**
 * Journal entries that the migrator would apply to a database whose newest
 * recorded migration is `lastCreatedAt` — the same rule as Drizzle's
 * `migrate()`: only entries younger than the newest row.
 */
export function pendingEntries(journal, lastCreatedAt) {
  if (lastCreatedAt == null) return [...journal.entries];
  return journal.entries.filter((e) => Number(lastCreatedAt) < Number(e.when));
}

/** The commit an image was built from, read from APP_BUILD_NUMBER (`<run>-<sha>`). */
export function commitOf(buildNumber) {
  const m = /([0-9a-f]{40})\s*$/.exec(buildNumber ?? "");
  return m ? m[1] : null;
}

/**
 * The parts of a Postgres error that are safe to report: the SQLSTATE and
 * the names of the objects involved. Never the message or its detail —
 * those can quote a value from a row ("invalid input syntax …: "x"",
 * "Key (email)=(…) already exists").
 */
export function safeError(err) {
  const parts = [];
  if (err?.code) parts.push(String(err.code));
  const names = [err?.schema && err?.table ? `${err.schema}.${err.table}` : err?.table, err?.column, err?.constraint]
    .filter(Boolean)
    .join(" ");
  if (names) parts.push(names);
  return parts.join(" ") || "error";
}

const KIND_TEXT = {
  missing: "missing on the copy",
  extra: "only on the copy",
  changed: "differs on the copy",
};

function cut(text) {
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 1)}…`;
}

/**
 * The status text for a result. Names only objects and migration tags, so
 * it can go to GitHub.
 */
export function describeResult(result) {
  switch (result.state) {
    case "success":
      return cut(`${result.applied} migration(s) applied to the copy of prod, schema equal to a fresh database`);
    case "pending":
      return "running on the copy of prod";
    case "failure": {
      if (result.failedMigration) {
        return cut(`${result.failedMigration} failed on the copy of prod: ${result.error ?? "error"}`);
      }
      if (result.unapplied?.length) {
        const more = result.unapplied.length > 1 ? ` (+${result.unapplied.length - 1})` : "";
        return cut(`skipped on the copy of prod: ${result.unapplied[0]}${more}`);
      }
      const first = result.differences?.[0];
      if (first) {
        const more = result.differences.length > 1 ? ` (+${result.differences.length - 1})` : "";
        return cut(`${first.key} ${KIND_TEXT[first.kind]}${more}`);
      }
      return cut(`failed: ${result.error ?? "unknown"}`);
    }
    default:
      return cut(`could not run: ${result.error ?? "unknown"}`);
  }
}
