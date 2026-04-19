/**
 * Thin wrapper around the pg_dump / pg_restore CLI binaries.
 *
 * The binaries must be installed in the runtime image (see
 * docker/Dockerfile.runtime). The connection parameters are passed via the
 * PG* environment variables so that the password never appears on the command
 * line or in log output.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

interface PgEnv {
  PGHOST: string;
  PGPORT: string;
  PGUSER: string;
  PGPASSWORD: string;
  PGDATABASE: string;
}

function pgEnv(database?: string): PgEnv {
  return {
    PGHOST: process.env.POSTGRES_HOST || "localhost",
    PGPORT: process.env.POSTGRES_PORT || "5432",
    PGUSER: process.env.POSTGRES_USER || "postgres",
    PGPASSWORD: process.env.POSTGRES_PASSWORD || "postgres",
    PGDATABASE: database ?? process.env.POSTGRES_DATABASE ?? "fk_encore",
  };
}

async function run(
  command: string,
  args: string[],
  env: PgEnv,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${command} aborted before spawn`));
      return;
    }
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    // Forward aborts to the child process so a caller that gave up waiting
    // can actually stop the running pg_dump instead of just leaking it.
    const onAbort = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`failed to spawn ${command}: ${err.message}`));
    });
    child.on("close", (code, sig) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error(`${command} aborted (signal=${sig ?? "none"})`));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

/**
 * Dump the given database in PostgreSQL custom format (-Fc) to the given file.
 * Custom format is compressed and supports selective restore via pg_restore.
 *
 * Passing an `AbortSignal` lets the caller terminate the pg_dump child process
 * mid-flight (e.g. when a backup safety timer fires while the dump is still
 * running on a loaded server).
 */
export async function pgDump(
  outputPath: string,
  database?: string,
  signal?: AbortSignal,
): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.promises.mkdir(dir, { recursive: true });

  await run(
    "pg_dump",
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--compress=6",
      "--file", outputPath,
    ],
    pgEnv(database),
    signal,
  );
}

/**
 * Restore a custom-format dump file into the given database.
 * The caller is responsible for creating/dropping the database if needed.
 *
 * Uses --clean --if-exists so existing objects are dropped and re-created,
 * which is safe for the fk-encore schema (no external dependencies).
 */
export async function pgRestore(inputPath: string, database?: string): Promise<void> {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`restore file does not exist: ${inputPath}`);
  }

  await run(
    "pg_restore",
    [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--dbname", pgEnv(database).PGDATABASE,
      inputPath,
    ],
    pgEnv(database),
  );
}

/**
 * Check whether the pg_dump / pg_restore binaries are installed.
 * Used at startup to fail fast with a clear error message if the image was
 * built without postgresql-client.
 */
export async function assertPgToolsAvailable(): Promise<void> {
  try {
    await run("pg_dump", ["--version"], pgEnv());
    await run("pg_restore", ["--version"], pgEnv());
  } catch (err: any) {
    throw new Error(
      `pg_dump/pg_restore not available in this image — install postgresql-client. Original error: ${err.message}`,
    );
  }
}
