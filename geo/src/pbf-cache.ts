/**
 * The PBF cache under /data/pbf — what stays and what goes.
 *
 * An import downloads its extract here and keeps it: replication and a
 * re-import read it, and the routing container (docs §24) builds its
 * tiles from every file in this directory. Nothing ever removed a file,
 * so a deleted region's extract stayed, and the router went on building
 * tiles for it — a whole continent, once, for a region nobody wanted.
 *
 * A file belongs to the region whose database name its file name maps
 * to: `us_new-york.pbf` and slug `us/new-york` both become
 * `nom_us_new_york` (the app's `slugToPostgresDb`). A file whose
 * database does not exist is an orphan — unless an import of that
 * database is running (the download comes first, the database after) or
 * the file is younger than a day.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

/** The region database a cached extract belongs to. */
export function postgresDbForPbf(fileName: string): string | null {
  if (!fileName.endsWith(".pbf")) return null;
  const base = fileName.slice(0, -".pbf".length);
  const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_");
  if (!safe.replace(/_/g, "")) return null;
  return `nom_${safe}`.replace(/_$/, "");
}

export interface PbfFile {
  name: string;
  mtimeMs: number;
}

export interface PruneInput {
  files: readonly PbfFile[];
  /** Region databases that exist. */
  liveDatabases: ReadonlySet<string>;
  /** Databases with an import running right now. */
  importing: ReadonlySet<string>;
  now: number;
  /** Files younger than this are left alone. */
  minAgeMs: number;
}

/** The files to delete: orphans old enough not to be a download in progress. */
export function orphanedPbfs(input: PruneInput): string[] {
  return input.files
    .filter((f) => {
      const db = postgresDbForPbf(f.name);
      if (!db) return false;
      if (input.liveDatabases.has(db) || input.importing.has(db)) return false;
      return input.now - f.mtimeMs >= input.minAgeMs;
    })
    .map((f) => f.name)
    .sort();
}

/** The files in the cache, `.pbf` only (a `.part` download is not one). */
export function listPbfs(dir: string): PbfFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".pbf"))
    .map((name) => ({ name, mtimeMs: statSync(path.join(dir, name)).mtimeMs }));
}

/** Delete the given files; a file already gone is not an error. */
export function removePbfs(dir: string, names: readonly string[]): string[] {
  const removed: string[] = [];
  for (const name of names) {
    try {
      unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return removed;
}

/** The cached extract(s) of one region database. */
export function pbfsForDatabase(files: readonly PbfFile[], postgresDb: string): string[] {
  return files.filter((f) => postgresDbForPbf(f.name) === postgresDb).map((f) => f.name);
}
